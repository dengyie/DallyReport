import { runSearch } from "../grok-cli.mjs";
import { frontMatter } from "../markdown.mjs";
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
    summary = `综合成功（${synthModel}，${sourceCount} 来源）`;
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

  // No diagnostic header block is written into the note — the report should read as
  // a clean, normal daily brief. Cred / search / synthesis issues surface only in the
  // CLI summary returned below, never inside the shipped markdown.
  const header = "";

  const body = [
    fm,
    "",
    `# AI 热点 · ${config.date}`,
    "",
    header,
    bodyText || "（模型未返回正文内容）",
    "",
  ].join("\n");

  // ok reflects the *delivered* report quality, not just the search round:
  // - synthesis attempted but failed -> body fell back to the raw answer; that is a
  //   degradation worth a ⚠️, not a clean ✅.
  // - synthesized / degraded-dump / normal-citation -> ok.
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
    // Reuse the sanitized source set for the AI poster headlines.
    sources,
  };
}
