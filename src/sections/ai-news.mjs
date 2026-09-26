import { runSearch } from "../grok-cli.mjs";
import { frontMatter, stripMarkdown } from "../markdown.mjs";
import { assertGrokCreds } from "../config.mjs";
import { synthesizeFromSources, synthesizeWithWebSearch, renderSources } from "../llm-synthesize.mjs";
import { fetchLinuxDoAiSources, mergeSourcesPreferLinuxDo } from "../linuxdo.mjs";
import { fetchNodeSeekAiSources } from "../nodeseek.mjs";
import { fetchV2exAiSources } from "../v2ex.mjs";
import { dedupeAndNormalizeSources } from "../news-dedup.mjs";
import { fetchAllDailySources } from "../sources-daily.mjs";
import { filterByRecency } from "../snippet-hygiene.mjs";

export function computeAiNewsStatus({
  searchOk,
  synthesized,
  synthAttemptedAndFailed,
  zeroCitation,
  sourceCount,
  linuxdoCount = 0,
  nodeseekCount = 0,
  v2exCount = 0,
  hasUsableDegradedDump,
  credErr = null,
  searchError = null,
  synthError = null,
  synthModel = "grok-4.5",
  synthFellBack = false,
  synthFallbackFrom = null,
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
    if (synthFellBack && synthFallbackFrom) {
      summary += `（${synthFallbackFrom} 失败，已回退 ${synthModel}）`;
    }
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

// Pure decision: should the section re-synthesize the body from our cleaned sources
// instead of shipping the raw answer? Community forums (linux.do / nodeseek / v2ex)
// are data-diversity inputs, so their presence can enable a synthesis round even
// when the Grok search itself is unavailable. Exported for unit tests.
export function shouldSynthesize({
  haveSources,
  searchOkForSynth,
  zeroCitation,
  communityCount,
  hasUsableDegradedDump,
}) {
  // A degraded grok-search dump is itself source-grounded; when there are NO
  // community sources re-synthesizing on top of it is redundant paid spend.
  const degradedReuseable = hasUsableDegradedDump && communityCount === 0;
  return (
    haveSources &&
    !degradedReuseable &&
    ((searchOkForSynth && zeroCitation) ||
      (!searchOkForSynth && communityCount > 0) ||
      (hasUsableDegradedDump && communityCount > 0))
  );
}

// The opts object parameterizes the query/model/name/H1 so the SAME pipeline can
// back both the main channel (defaults) and the alt channel (resolveAltChannel in
// run.mjs). Defaults match the pre-parameterization behavior exactly, so existing
// callers pass just config. The alt channel writes its own file (different name)
// and attributes its summary to the actual writer model.
// Execute a gemini-initiated web_search query through the shared search layer
// (Tavily/Firecrawl, model-agnostic) and return the cleaned result block for
// injection as a tool response. De-pollution/defense-in-depth is inherited from
// renderSources (sanitizeSnippet + clarifySnippet).
async function gemSearch(query, config) {
  const result = await runSearch(query, config, { days: config.days, extra: config.extra });
  const cards = result?.sources?.extra?.length
    ? result.sources.extra
    : result?.sources?.merged || [];
  return renderSources(cards);
}

export async function aiNewsSection(
  config,
  {
    name = "AI",
    model = config.synthModel,
    queryTemplate = config.aiQueryTemplate,
    title,
    synthTimeoutMs = config.synthTimeoutMs,
  } = {},
) {
  const ai = (queryTemplate || "今天{date}最新的AI资讯和大模型动态").replace(/\{date\}/g, config.date);
  let result;
  let searchError = null;
  const credErr = assertGrokCreds();

  // Kick off the general search and the community scrapes in parallel. The forums
  // (linux.do, nodeseek, v2ex) are independent of Grok creds (they only need fetch
  // providers), so they still run even if assertGrokCreds fails — worst case we
  // synthesize from the forums alone. De-pollution: these are data-diversity inputs
  // only; they are merged ahead of general sources for synthesis and never written
  // into the shipped note (no names, no counts, no [N] markers).
  const searchPromise = (async () => {
    if (credErr) return null;
    try {
      return await runSearch(ai, config, { days: config.days, extra: config.extra });
    } catch (e) {
      searchError = e;
      return null;
    }
  })();
  const fallbackCommunity = (key) => (error) => {
    const fallback = [];
    Object.defineProperty(fallback, key, {
      value: { kind: "collector", failures: [{ message: error?.message || String(error) }] },
      enumerable: false,
    });
    return fallback;
  };
  const linuxdoPromise = fetchLinuxDoAiSources(config).catch(fallbackCommunity("linuxdoError"));
  const nodeseekPromise = fetchNodeSeekAiSources(config).catch(fallbackCommunity("nodeseekError"));
  const v2exPromise = fetchV2exAiSources(config).catch(fallbackCommunity("v2exError"));
  // Daily hard sources (HN/36kr/arXiv) — zero-config public APIs that guarantee a
  // same-day baseline so the writer never has to hallucinate on quiet days.
  const dailySourcePromise = fetchAllDailySources(config).catch(fallbackCommunity("dailySourcesError"));

  const [searchResult, linuxdoSources, nodeseekSources, v2exSources, dailySources] = await Promise.all([
    searchPromise,
    linuxdoPromise,
    nodeseekPromise,
    v2exPromise,
    dailySourcePromise,
  ]);
  result = searchResult;

  // 2026-09-25 review: collector failures previously existed only as non-enumerable
  // metadata that NO production code read — a nodeseek/v2ex/daily outage degraded
  // the report silently while stdout showed a clean ✅. Collect them here so they
  // reach the section summary line (launchd log) and the section result.
  const degradedSources = [];
  for (const [label, arr, errKey] of [
    ["linux.do", linuxdoSources, "linuxdoError"],
    ["nodeseek", nodeseekSources, "nodeseekError"],
    ["v2ex", v2exSources, "v2exError"],
    ["当日硬源", dailySources, "dailySourcesError"],
  ]) {
    if (arr?.[errKey]) {
      degradedSources.push(`${label}（${arr[errKey].failures?.[0]?.message || "采集失败"}）`);
      continue;
    }
    // Partial-failure shape: { listingFailures, deepFetchFailures,
    // cacheWriteFailures, jsonApiFailures } — an earlier draft checked a
    // nonexistent `failures` key, which made this branch dead code (2026-09-26
    // fresh-eyes review).
    const diag = arr?.communityDiagnostics ?? arr?.linuxdoDiagnostics;
    const failureCount = diag
      ? (diag.listingFailures?.length || 0) +
        (diag.deepFetchFailures?.length || 0) +
        (diag.cacheWriteFailures?.length || 0) +
        (diag.jsonApiFailures?.length || 0)
      : 0;
    if (failureCount) {
      degradedSources.push(`${label}（${failureCount} 项采集失败）`);
    }
  }

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
  // Primary hard sources (daily HN/36kr/arXiv + general search results) get the bulk of the budget.
  // Community sources (linux.do, nodeseek, v2ex) provide bounded forum signals (strictly capped & denoised).
  const primarySources = [...(dailySources || []), ...(generalSources || [])];
  const communitySources = [...(nodeseekSources || []), ...(v2exSources || [])];
  const merged = mergeSourcesPreferLinuxDo(linuxdoSources, primarySources, {
    maxTotal: config.sourceMaxTotal ?? 18,
    linuxdoMaxTotal: config.linuxdoMaxSources ?? 4,
    extraCommunitySources: communitySources,
    extraCommunityMaxTotal: 3,
  });
  // Semantic de-dup + title normalization: fold same-event posts (e.g. the 8
  // "quota reset" threads on a reset day) into one representative card with a
  // clear, self-contained headline, so the model isn't handed 8 near-identical
  // sources and doesn't have to guess they're one story. Deterministic, zero-LLM.
  // The raw linux.do cards (linuxdoRaw) are untouched — the auxiliary file stays
  // a verbatim archive.
  const deduped = dedupeAndNormalizeSources(merged);
  // Recency gate: sources carrying a publishedAt (HN/36kr/arXiv) older than today
  // (Beijing) are dropped; timestamp-less sources (tavily/firecrawl) pass through.
  // The dropped count is surfaced in the report header as a material-window note.
  const { sources, dropped: recencyDropped } = filterByRecency(deduped, config.date);
  const linuxdoCount = (linuxdoSources || []).length;
  const nodeseekCount = (nodeseekSources || []).length;
  const v2exCount = (v2exSources || []).length;
  const communityCount = linuxdoCount + nodeseekCount + v2exCount;
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
  let synthFellBack = false;
  let synthFallbackFrom = null;
  let bodyText = rawAnswerText;
  const hasUsableDegradedDump = degraded && rawAnswerText.trim().length >= 120;
  // When to synthesize:
  //   (a) zero-citation (model would hallucinate) and we have real sources;
  //   (b) search failed/creds missing but any community forum (linux.do /
  //       nodeseek / v2ex) produced usable sources;
  //   (c) grok-search went degraded (dirty Tavily/Firecrawl dump as answer) AND
  //       we have community sources — the degraded dump is injection-noisy and
  //       buries the forum signal, so re-synthesizing from our cleaned sources
  //       beats reusing it. (When degraded with NO community sources, reuse the
  //       dump to avoid a second paid round on top of an already-grounded body.)
  const haveSources = sources.length > 0;
  const searchOkForSynth = !credErr && !searchError && result;
  const shouldSynth = shouldSynthesize({
    haveSources,
    searchOkForSynth,
    zeroCitation,
    communityCount,
    hasUsableDegradedDump,
  });
  if (shouldSynth) {
    // gemini alt writer: when web_search is enabled, run the bounded tool loop
    // (gemini emits web_search queries -> we execute them via grok-search -> feed
    // results back -> converge). All other writers keep the one-shot synthesis.
    const geminiLoop =
      model === "gemini-3.6-flash" && config.aiAltGeminiWebSearch !== false;
    const runOneShot = (m) =>
      synthesizeFromSources({
        query: ai,
        date: config.date,
        sources,
        model: m,
        maxTokens: config.synthMaxTokens,
        timeoutMs: synthTimeoutMs,
      });
    try {
      bodyText = geminiLoop
        ? await synthesizeWithWebSearch({
            query: ai,
            date: config.date,
            sources,
            model,
            maxTokens: config.synthMaxTokens,
            timeoutMs: synthTimeoutMs,
            maxSearchRounds: config.aiAltGeminiMaxRounds,
            searchImpl: (q) => gemSearch(q, config),
          })
        : await runOneShot(model);
      synthesized = true;
    } catch (e) {
      // Main writer failed (e.g. a slow reasoning model that 524s over the
      // gateway's ~120s Cloudflare cap). Retry the one-shot synthesis once with
      // the configured fallback model so the daily report still completes. The
      // gemini web_search loop is skipped here — it has its own bounded loop.
      const fb = config.synthFallbackModel;
      if (!geminiLoop && fb && fb !== model) {
        try {
          bodyText = await runOneShot(fb);
          synthesized = true;
          synthFellBack = true;
          synthFallbackFrom = model;
          synthError = null;
        } catch (e2) {
          synthError = e2;
          // bodyText already = rawAnswerText; keep going, document the fallback.
        }
      } else {
        synthError = e;
        // bodyText already = rawAnswerText; keep going, document the fallback.
      }
    }
  }

  // 2026-09-25 review: when synthesis was attempted and failed, bodyText is the
  // model's raw memory-based answer — exactly the hallucination "plan B" exists
  // to replace. The ⚠️ used to live only in the stdout summary nobody reads; the
  // delivered note must self-describe the degradation.
  const synthAttemptedAndFailed = shouldSynth && synthError;
  const synthFailedNote = synthAttemptedAndFailed
    ? `> ⚠️ **综合失败（${synthError?.code || "unknown"}）**：以下为未经来源核实的模型原始回答，可能与当日事实不符，请谨慎阅读。\n\n`
    : "";

  const fm = frontMatter({
    date: config.date,
    updated: new Date().toISOString(),
    tags: ["日报", "AI"],
    days_dropped: daysDropped,
  });

  // Material-window counts must reflect what the model ACTUALLY received: merge
  // (URL-dedup + caps), event-cluster folding and the recency gate all shrink the
  // raw fetch — counting the raw fetch overstated "当日素材" and could suppress
  // the low-material warning (2026-09-25 review). Match survivors back to the
  // daily fetch by URL.
  const dailyUrlSet = new Set((dailySources || []).map((s) => s?.url).filter(Boolean));
  const dailyCount = sources.filter((s) => dailyUrlSet.has(s?.url)).length;
  const genericCount = Math.max(0, sources.length - dailyCount);
  let header = "";
  if (config.reportStrictDaily !== false) {
    const windowParts = [`当日素材 ${dailyCount} 条`, `近几日来源 ${genericCount} 条`];
    if (recencyDropped > 0) windowParts.push(`过期已过滤 ${recencyDropped} 条`);
    header = `> **素材窗口**：${windowParts.join("；")}。\n\n`;
    if (dailyCount < 8) {
      header += `> ⚠️ **低素材提示**：当日硬源不足 8 条，正文以近期趋势为主，请注意时效。\n\n`;
    }
  }

  // Append reference sources section at the bottom. Parses [N] markers from the
  // body text to show only the sources actually cited by the model. When no [N]
  // markers are found (fallback/degraded path), shows all sources (capped at 30).
  const bodyTextOrDefault = bodyText || "";
  const citedIndices = new Set();
  const citeRe = /\[(\d+)\]/g;
  let citeMatch;
  while ((citeMatch = citeRe.exec(bodyTextOrDefault)) !== null) {
    const idx = Number.parseInt(citeMatch[1], 10) - 1; // 1-indexed in text
    if (idx >= 0 && idx < sources.length) citedIndices.add(idx);
  }
  const citedSources = citedIndices.size
    ? [...citedIndices].sort((a, b) => a - b).map((i) => sources[i])
    : sources;
  const refLines = citedSources.slice(0, 30).map((s) => {
    // Strip markdown fragments from scraped titles first (v2ex/linuxdo titles
    // can carry `[...](...)` residue and reply metadata), THEN escape what
    // remains so parens can't break the markdown link syntax.
    const title = stripMarkdown(s.title || s.url || "来源").replace(
      /[\[\]()]/g,
      (c) => "\\" + c,
    );
    const url = s.url || "";
    return url ? `- [${title}](<${url}>)` : `- ${title}`;
  });
  const refSection = refLines.length
    ? `\n\n---\n\n### 参考来源\n\n${refLines.join("\n")}`
    : "";

  const body = [
    fm,
    "",
    title ?? `# AI 热点 · ${config.date}`,
    "",
    header,
    synthFailedNote,
    bodyText || "（模型未返回正文内容）",
    refSection,
    "",
  ].join("\n");

  // ok reflects the *delivered* report quality, not just the search round:
  // - synthesis attempted but failed -> body fell back to the raw answer; that is a
  //   degradation worth a ⚠️, not a clean ✅.
  // - synthesized / degraded-dump / normal-citation -> ok.
  // - search failed AND no usable synthesis -> not ok.
  const searchOk = !!result && !searchError && !credErr;
  const { ok, summary } = computeAiNewsStatus({
    searchOk,
    synthesized,
    synthAttemptedAndFailed,
    zeroCitation,
    sourceCount: sources.length,
    recencyDropped,
    dailySourceCount: dailyCount,
    linuxdoCount,
    nodeseekCount,
    v2exCount,
    hasUsableDegradedDump,
    credErr,
    searchError,
    synthError,
    synthModel: synthFellBack && synthFallbackFrom ? config.synthFallbackModel : model,
    synthFellBack,
    synthFallbackFrom,
  });

  // Degraded collectors must be visible where operators actually look (the
  // launchd summary line), not only in non-enumerable metadata.
  const summaryLine = degradedSources.length
    ? `${summary}；⚠️ 部分来源不可用：${degradedSources.join("、")}`
    : summary;

  return {
    ok,
    name,
    markdown: body,
    summary: summaryLine,
    // Non-empty when any collector failed / partially failed (see above).
    degradedSources,
    zeroCitation,
    synthesized,
    synthFailed: synthAttemptedAndFailed,
    sourceCount: sources.length,
    linuxdoCount,
    nodeseekCount,
    v2exCount,
    // Reuse the sanitized source set for the AI poster headlines.
    sources,
    // Poster/mirror alignment: the poster renders the sources the article
    // actually cited, so the poster is a visualization of the article rather
    // than a different (forum-first) source set. Falls back to all sources
    // when the body carried no [N] citations (fallback/degraded path).
    posterSources: citedSources.length ? citedSources : sources,
    // Raw linuxdo news/34 cards for auxiliary materials (all today's posts, no
    // AI filter, no cap). Written to a separate file by run.mjs.
    linuxdoRaw: linuxdoSources?.linuxdoRaw || [],
  };
}
