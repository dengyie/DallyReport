import { runSearch } from "../grok-cli.mjs";
import { frontMatter, sourceList } from "../markdown.mjs";
import { assertGrokCreds } from "../config.mjs";
import { synthesizeFromSources } from "../llm-synthesize.mjs";
import { fetchLinuxDoAiSources, mergeSourcesPreferLinuxDo } from "../linuxdo.mjs";

export function computeAiNewsStatus({
  searchOk,
  synthesized,
  synthAttemptedAndFailed,
  zeroCitation,
  sourceCount,
  linuxdoCount = 0,
  hasUsableDegradedDump,
  credErr = null,
  searchError = null,
  synthError = null,
  synthModel = "grok-4.5",
} = {}) {
  const zeroContentHallucination =
    zeroCitation && sourceCount === 0 && !synthesized && !hasUsableDegradedDump;
  const ok =
    (searchOk || synthesized) &&
    !synthAttemptedAndFailed &&
    !zeroContentHallucination;

  let summary;
  if (synthAttemptedAndFailed) {
    const truncated = String(synthError?.code || "").startsWith("SYNTH_TRUNCATED");
    summary = truncated
      ? `综合截断已回退原始回答（${synthError.code}）`
      : `综合失败已回退原始回答（${synthError?.code || "?"}）`;
  } else if (synthesized) {
    summary =
      linuxdoCount > 0
        ? `综合成功（${synthModel}，${sourceCount} 来源，linux.do ${linuxdoCount}）`
        : `综合成功（${synthModel}，${sourceCount} 来源）`;
  } else if (credErr) {
    summary = "missing grok creds";
  } else if (!searchOk) {
    summary = searchError?.timedOut ? "搜索超时（failed）" : "failed";
  } else if (hasUsableDegradedDump) {
    summary = `降级原始摘要（${sourceCount} 来源）`;
  } else if (zeroContentHallucination) {
    summary = "零来源零回引（正文为模型臆测，已降级标注）";
  } else if (zeroCitation) {
    summary = "Grok 零回引（已标注降级）";
  } else {
    summary = "success";
  }

  return { ok, summary, zeroContentHallucination };
}

export async function aiNewsSection(config) {
  const ai = (config.aiQueryTemplate || "").replace(/\{date\}/g, config.date);
  let result;
  let searchError = null;
  const credErr = assertGrokCreds();

  // Kick off the general search and the linux.do scrape in parallel. linux.do is
  // independent of Grok creds (it only needs fetch providers), so it still runs
  // even if assertGrokCreds fails — worst case we synthesize from forum alone.
  const searchPromise = (async () => {
    if (credErr) return null;
    try {
      return await runSearch(ai, config, { days: config.days, extra: config.extra });
    } catch (e) {
      searchError = e;
      return null;
    }
  })();
  const linuxdoPromise = fetchLinuxDoAiSources(config).catch((error) => {
    const fallback = [];
    Object.defineProperty(fallback, "linuxdoError", {
      value: { kind: "collector", failures: [{ message: error?.message || String(error) }] },
      enumerable: false,
    });
    return fallback;
  });

  const [searchResult, linuxdoSources] = await Promise.all([searchPromise, linuxdoPromise]);
  result = searchResult;

  const grokCitations =
    result?.diagnostics?.provider_attempts?.find((a) =>
      String(a.provider || "").startsWith("grok-responses"),
    )?.count ?? 0;
  const zeroCitation = result ? grokCitations === 0 : false;
  const degraded = result?.diagnostics?.degraded === true;
  const warnings = [...(result?.diagnostics?.warnings || [])];
  const linuxdoError = linuxdoSources?.linuxdoError || null;
  const linuxdoDiagnostics = linuxdoSources?.linuxdoDiagnostics || null;
  const linuxdoWarningParts = [];
  if (linuxdoError) {
    linuxdoWarningParts.push(
      `linux.do 抓取失败：${linuxdoError.failures?.map((f) => f.message).filter(Boolean).join("；") || "未知错误"}`,
    );
  }
  if (linuxdoDiagnostics?.listingFailures?.length && !linuxdoError) {
    linuxdoWarningParts.push(`linux.do 列表部分失败（${linuxdoDiagnostics.listingFailures.length} 个）`);
  }
  if (linuxdoDiagnostics?.deepFetchFailures?.length) {
    linuxdoWarningParts.push(
      `linux.do 主题详情抓取失败（${linuxdoDiagnostics.deepFetchFailures.length} 个，已保留标题卡片）`,
    );
  }
  if (linuxdoDiagnostics?.cacheWriteFailures?.length) {
    linuxdoWarningParts.push(
      `linux.do 缓存写入失败（${linuxdoDiagnostics.cacheWriteFailures.length} 个，实时内容仍已使用）`,
    );
  }
  const linuxdoWarning = linuxdoWarningParts.length
    ? linuxdoWarningParts.join("；")
    : null;
  const linuxdoCache = linuxdoSources?.linuxdoCache || null;
  const linuxdoCacheWarning = linuxdoCache?.fromCache
    ? "linux.do 来源来自本地缓存，实时状态未验证"
    : null;
  const daysDropped = result?.diagnostics?.options?.days_dropped ?? null;
  const generalSources = result?.sources?.extra?.length
    ? result.sources.extra
    : result?.sources?.merged || [];
  // linux.do first so synthesis cites them as [1]..[N]; de-dupe by URL.
  const sources = mergeSourcesPreferLinuxDo(linuxdoSources, generalSources, {
    maxTotal: config.sourceMaxTotal ?? 16,
  });
  const linuxdoCount = (linuxdoSources || []).length;
  const rawAnswerText = result?.answer?.text || "";

  // Plan B: when the gateway has zero citations (no /responses web_search backend),
  // the raw answer is the model hallucinating from training memory. But Tavily/
  // Firecrawl sources are real same-day. Re-synthesize the body from those sources
  // via /chat/completions so the report reflects actual current content instead of
  // "我无法提供今日…". Falls back to rawAnswerText if synthesis can't be done.
  //
  // Caveat: when grok-search itself went *degraded* it already produced a visibly
  // marked raw Tavily/Firecrawl dump as answer.text - that dump is itself source-
  // grounded, so re-synthesizing on top of it is redundant spend and can be a worse
  // artifact. So we synthesize only when the model fabricated from memory: zero
  // citation AND not in degraded mode (or degraded but with no usable dump body).
  let synthesized = false;
  let synthError = null;
  let bodyText = rawAnswerText;
  const hasUsableDegradedDump = degraded && rawAnswerText.trim().length >= 120;
  // When to synthesize:
  //   (a) zero-citation (model would hallucinate) and we have real sources;
  //   (b) search failed/creds missing but linux.do produced usable sources;
  //   (c) grok-search went degraded (dirty Tavily/Firecrawl dump as answer) AND
  //       we got linux.do sources — the degraded dump is injection-noisy and buries
  //       the forum signal, so re-synthesizing from our cleaned sources beats
  //       reusing it. (When degraded with NO linux.do sources, reuse the dump to
  //       avoid a second paid round on top of an already-grounded body.)
  const haveSources = sources.length > 0;
  const searchOkForSynth = !credErr && !searchError && result;
  const degradedReuseable = hasUsableDegradedDump && linuxdoCount === 0;
  const shouldSynth =
    haveSources &&
    !degradedReuseable &&
    ((searchOkForSynth && zeroCitation) ||
      (!searchOkForSynth && linuxdoCount > 0) ||
      (hasUsableDegradedDump && linuxdoCount > 0));
  if (shouldSynth) {
    try {
      bodyText = await synthesizeFromSources({
        query: ai,
        date: config.date,
        sources,
        model: config.synthModel,
        maxTokens: config.synthMaxTokens,
        timeoutMs: config.synthTimeoutMs,
      });
      synthesized = true;
    } catch (e) {
      synthError = e;
      // bodyText already = rawAnswerText; keep going, document the fallback.
    }
  }

  const fm = frontMatter({
    date: config.date,
    updated: new Date().toISOString(),
    tags: ["日报", "AI"],
    days_dropped: daysDropped,
  });

  let header = "";
  // Even when general search fails / lacks creds, a successful linux.do-backed
  // synthesis still produces a usable section — only show hard-fail headers when
  // we truly have nothing to deliver.
  const deliveredFromLinuxdoOnly = synthesized && linuxdoCount > 0 && (!result || searchError || credErr);
  if (credErr && !deliveredFromLinuxdoOnly && !synthesized) {
    header =
      `> ⚠️ ${credErr.message}\n` +
      `> 本节因缺凭证留空，请在 .env 填入 GROK_API_URL / GROK_API_KEY 后重跑。\n` +
      (linuxdoWarning ? `> ⚠️ ${linuxdoWarning}\n` : "") +
      (linuxdoCacheWarning ? `> ⚠️ ${linuxdoCacheWarning}\n` : "") +
      "\n";
  } else if (searchError && !deliveredFromLinuxdoOnly && !synthesized) {
    header =
      `> ⚠️ Grok 搜索失败：${searchError.message}\n` +
      `> 本节因后端不可用而留空，请检查 grok-search 与 .env 后重跑。\n` +
      (linuxdoWarning ? `> ⚠️ ${linuxdoWarning}\n` : "") +
      (linuxdoCacheWarning ? `> ⚠️ ${linuxdoCacheWarning}\n` : "") +
      "\n";
  } else {
    const notes = [];
    if (credErr && deliveredFromLinuxdoOnly) {
      notes.push(`Grok 凭证缺失，但已用 linux.do 论坛 ${linuxdoCount} 条来源综合正文。`);
    } else if (searchError && deliveredFromLinuxdoOnly) {
      notes.push(`Grok 搜索失败（${searchError.message}），已回退为 linux.do 论坛 ${linuxdoCount} 条来源综合。`);
    }
    if (synthesized) {
      const ldNote =
        linuxdoCount > 0
          ? `已优先纳入 linux.do 论坛 ${linuxdoCount} 条 AI 相关帖；`
          : "";
      const degradedNote =
        hasUsableDegradedDump && linuxdoCount > 0
          ? "网关进入降级模式（原始 dump 含博取/注入噪声），改为"
          : "网关无 /responses 实时引用（零回引）。本节正文已改用";
      notes.push(
        `${degradedNote}当日抓取来源（含 Tavily/Firecrawl${linuxdoCount > 0 ? " + linux.do" : ""}），由 ${config.synthModel} 经 /chat/completions 综合生成，下方来源卡片为依据。${ldNote}`,
      );
    } else if (hasUsableDegradedDump) {
      // grok-search handed us a source-grounded raw dump and we had no linux.do
      // sources worth re-synthesizing on top of — reuse it rather than paying for
      // a second round.
      notes.push(
        "网关无 /responses 实时引用且进入降级模式。本节正文为 grok-search 基于 Tavily/Firecrawl 来源拼装的原始摘要（未经过模型重写），下方来源卡片为依据。",
      );
    } else if (zeroCitation || degraded) {
      // Zero citation with no usable dump: the model fabricated from training memory.
      notes.push(
        "本节由模型自行生成，Grok 回引受限 - 下方正文未经来源核实，请以来源卡片为准。",
      );
    }
    if (synthError) {
      // Truncation (SYNTH_TRUNCATED*) is a deliberate fallback, not a silent failure:
      // we refuse to ship a possibly-incomplete synthesis and keep the raw answer.
      const truncated = String(synthError.code || "").startsWith("SYNTH_TRUNCATED");
      notes.push(
        truncated
          ? `来源综合被截断（${synthError.code}），为避免发布不完整正文已回退为原始回答：${synthError.message}`
          : `来源综合失败（${synthError.code || "?"}: ${synthError.message}），已回退为模型原始回答。`,
      );
    }
    if (daysDropped) {
      notes.push(`已按 --days ${config.days} 过滤掉 ${daysDropped} 条更早的来源。`);
    }
    if (linuxdoWarning) {
      notes.push(linuxdoWarning);
    }
    if (linuxdoCacheWarning) {
      notes.push(linuxdoCacheWarning);
    }
    if (warnings.length) {
      notes.push(`搜索警告：${warnings.join("；")}`);
    }
    if (notes.length) header = `> ℹ️ ${notes.join("\n> \n> ")}\n\n`;
  }

  const body = [
    fm,
    "",
    `# AI 资讯 · ${config.date}`,
    "",
    header,
    bodyText || "（模型未返回正文内容）",
    "",
    "## 来源",
    "",
    sourceList(sources),
    "",
  ].join("\n");

  // ok reflects the *delivered* report quality, not just the search round:
  // - synthesis attempted but failed -> body fell back to the hallucinated raw
  //   answer; that is a degradation worth a ⚠️, not a clean ✅.
  // - synthesized (incl. linux.do-only) / degraded-dump / normal-citation -> ok.
  // - search failed AND no usable synthesis -> not ok.
  const searchOk = !!result && !searchError && !credErr;
  const synthAttemptedAndFailed = shouldSynth && synthError;
  const { ok, summary } = computeAiNewsStatus({
    searchOk,
    synthesized,
    synthAttemptedAndFailed,
    zeroCitation,
    sourceCount: sources.length,
    linuxdoCount,
    hasUsableDegradedDump,
    credErr,
    searchError,
    synthError,
    synthModel: config.synthModel,
  });

  return {
    ok,
    name: "AI",
    markdown: body,
    summary,
    zeroCitation,
    synthesized,
    synthFailed: synthAttemptedAndFailed,
    sourceCount: sources.length,
    linuxdoCount,
  };
}
