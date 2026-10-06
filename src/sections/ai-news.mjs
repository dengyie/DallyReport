import { runSearch, redactSecrets } from "../grok-cli.mjs";
import { frontMatter, stripMarkdown, sanitizeUrl } from "../markdown.mjs";
import { assertGrokCreds } from "../config.mjs";
import { synthesizeFromSources, synthesizeWithWebSearch, renderSources } from "../llm-synthesize.mjs";
import { fetchLinuxDoAiSources, mergeSourcesPreferLinuxDo } from "../linuxdo.mjs";
import { fetchNodeSeekAiSources } from "../nodeseek.mjs";
import { fetchV2exAiSources } from "../v2ex.mjs";
import { dedupeAndNormalizeSources } from "../news-dedup.mjs";
import { splitOverMergedBullets } from "../prose-tighten.mjs";
import { fetchAllDailySources } from "../sources-daily.mjs";
import { filterByRecency, isInWindowSource } from "../snippet-hygiene.mjs";
import { materialWindow } from "../report-window.mjs";
import { topicize, gradeTopics, applyGradeCap } from "../topics.mjs";
import { investigateTopics, renderInvestigationInput } from "../investigate.mjs";
import { enforceOneTopicPerBullet } from "../topic-bullets.mjs";

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

// The `[N]` markers in the body index the FULL, 1-based source list the model
// was given. This returns the cited subset as `{n, source}` pairs that keep
// that original number, so the renderer can never renumber them by position.
//
// 2026-09-27 review B1: the selection was a bare array of sources and the
// reference renderer numbered them 1..N. A body citing [1] and [6] against a
// 5-entry list therefore produced a two-line reference block whose second line
// was silently the WRONG source — visible in the shipped 2026-09-27 note, and
// the same wrong pairing reached the poster via `posterSources`.
// A citation marker is one bracketed group holding one or more comma-separated
// 1-based numbers. The multi-number form is not optional decoration: a body that
// attributes one claim to two sources at once writes "[22, 25]", and the older
// single-number pattern did not match that string AT ALL — the scan consumed
// "[22" and died on the comma, so neither number was recorded. The shipped
// 2026-09-25 weekly shipped exactly that marker, and sources 22 and 25 reached
// the reader as citations pointing at nothing, with no error anywhere.
//
// The group is validated as a whole before any number inside it is trusted, so
// a malformed half ("[2, abc]") contributes nothing rather than contributing its
// well-formed neighbour under a marker the body never wrote.
const CITE_RE = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

export function selectCitedSources(sources, bodyText) {
  const list = sources || [];
  const indices = new Set();
  let m;
  while ((m = CITE_RE.exec(bodyText || "")) !== null) {
    for (const part of m[1].split(",")) {
      const idx = Number.parseInt(part.trim(), 10) - 1;
      // Out-of-range markers are ignored rather than clamped: a body that cites
      // [9] against 8 sources is malformed, and mapping it onto source 8 would
      // assert a link the model never made.
      if (Number.isInteger(idx) && idx >= 0 && idx < list.length) indices.add(idx);
    }
  }
  if (!indices.size) {
    return list.map((source, i) => ({ n: i + 1, source }));
  }
  return [...indices]
    .sort((a, b) => a - b)
    .map((i) => ({ n: i + 1, source: list[i] }));
}

// Turn the per-provider hard-source diagnostics into reader-facing labels.
//
// 2026-09-28 H1: a STARVED source is not a collection failure. It fetched fine
// and the recency window emptied it, so labelling that "N 项采集失败" sends the
// reader to check the network when the calendar is the actual cause. On
// 2026-09-28 all five vendor blogs were starved, so the summary would have
// blamed five healthy feeds for a quiet publishing week — and the report still
// printed a green success line over forum chatter. Pure + exported so both
// directions are unit-testable without touching the network.
export function formatDailySourceDiagnostics(
  dailyDiag,
  label = "当日硬源",
  starvedText = "当日无新内容",
) {
  if (!dailyDiag || typeof dailyDiag !== "object") return [];
  const out = [];
  for (const [provider, info] of Object.entries(dailyDiag)) {
    if (!(info?.count > 0)) continue;
    const starved = info.sample?.some((f) => f?.reason === "no-fresh-items-in-window");
    out.push(
      starved
        ? `${label}/${provider}（${starvedText}）`
        : `${label}/${provider}（${info.count} 项采集失败）`,
    );
  }
  return out;
}

// 2026-09-28 weekly: every user-facing noun for the reporting period, in one
// place. Scattered conditionals through the section meant a weekly shipped
// "当日素材 N 条" over seven days of evidence — the note then describes its own
// material as a single day, and the 低素材 threshold (a *daily* budget) is
// consulted against a week's worth of cards, so a genuinely starved week never
// trips it. mode is the report mode; undefined means daily, because bare
// {date} test configs reach these helpers.
export function reportPeriodWords(mode) {
  return mode === "weekly"
    ? { material: "本周素材", sources: "近 7 日来源", hard: "本周硬源", starved: "本周无新内容" }
    : { material: "当日素材", sources: "近几日来源", hard: "当日硬源", starved: "当日无新内容" };
}

// The low-material threshold is a per-day budget, so it has to scale with the
// window: a healthy week carries ~7x a healthy day, and comparing a week's
// count against a day's threshold would silence the warning exactly when it is
// most needed. 8 * 7 = 56 is far above any real weekly haul, so the weekly uses
// a deliberately conservative 20 — enough to catch a week where the hard
// sources were genuinely starved, not a week that merely trended quiet.
export function lowMaterialThresholdFor(mode) {
  return mode === "weekly" ? 20 : 8;
}

// Pure + exported so the wording is unit-testable without a live section run,
// matching computeAiNewsStatus / formatDailySourceDiagnostics above.
export function buildMaterialWindowHeader({
  dailyCount = 0,
  genericCount = 0,
  recencyDropped = 0,
  mode = "daily",
} = {}) {
  const w = reportPeriodWords(mode);
  const parts = [`${w.material} ${dailyCount} 条`, `${w.sources} ${genericCount} 条`];
  if (recencyDropped > 0) parts.push(`过期已过滤 ${recencyDropped} 条`);
  let header = `> **素材窗口**：${parts.join("；")}。\n\n`;
  const threshold = lowMaterialThresholdFor(mode);
  if (dailyCount < threshold) {
    header += `> ⚠️ **低素材提示**：${w.hard}不足 ${threshold} 条，正文以近期趋势为主，请注意时效。\n\n`;
  }
  return header;
}

// Count same-day material. See isSameDaySource for why recency, not the
// fromDaily stamp, decides this. Exported for unit tests.
// `window` is the weekly span; omitted, the source must fall inside the report
// DAY, which is what every daily note and the 2026-09-27 tests assert.
export function countDailySources(sources, dateStr, window) {
  return (sources || []).filter((s) => isInWindowSource(s, dateStr, window)).length;
}

// Render the reference bullets. `deps` exists so the unit test can drive the
// pure formatting without the module's own imports.
// Numbers in the body index the list the model was shown. That list is
// `investigation.sources` once investigation has replaced the collected cards.
// Resolving [N] against the pre-investigation list points every marker at the
// wrong page as soon as a D-grade card is removed or a new URL is appended.
export function assembleInvestigatedBody({ collected, investigation, body, date } = {}) {
  const shown = investigation?.sources || collected || [];
  const cited = selectCitedSources(shown, body);
  const ref = buildReferenceLines(cited).join("\n");
  const noMarkers = !/\[\d+/.test(body || "");
  return {
    ref,
    posterSources: noMarkers ? shown : cited.map((c) => c.source),
    dailyCount: countDailySources(shown, date),
    shown,
  };
}

export function buildReferenceLines(
  cited,
  deps = { stripMarkdown, sanitizeUrl },
  max = 30,
) {
  return (cited || []).slice(0, max).map(({ n, source: s }, i) => {
    // Strip markdown fragments from scraped titles first (v2ex/linuxdo titles
    // can carry `[...](...)` residue and reply metadata), THEN escape what
    // remains so parens can't break the markdown link syntax.
    const title = deps.stripMarkdown(s.title || s.url || "来源").replace(
      /[\[\]()]/g,
      (c) => "\\" + c,
    );
    // 2026-09-26 review P1: this renderer used to emit `s.url` verbatim, so an
    // attacker-authored `javascript:` href from a scraped post became a live
    // clickable link in the user's note. markdown.mjs already owned the correct
    // defense (sanitizeUrl rejects any non-http(s) scheme) and its own
    // sourceCard used it — but sourceCard has zero production callers, so the
    // two tests guarding it protected code that never shipped while this path
    // ran unvalidated. Degrade to a plain title when the URL is not http(s).
    const url = deps.sanitizeUrl(s.url);
    // 2026-09-28 review G1: the bullets are unnumbered, so the ONLY way a reader
    // resolves a body's `[N]` is by reading the number off the list. B1 stopped
    // the renderer from RENUMBERING the filtered subset, but it never made the
    // number visible — `n` was destructured away right here. So `[N]` was still
    // positional, and any body that skipped a marker (the shipped 2026-09-28
    // cited [2]..[10] over 9 bullets) pointed every marker one line off, with
    // the tail marker pointing at no line at all.
    //
    // `n ?? i + 1` keeps a hand-built entry (no `n`) numbered by position
    // rather than printing a literal `[undefined]`.
    const num = Number.isInteger(n) && n > 0 ? n : i + 1;
    return url ? `- [${num}] [${title}](<${url}>)` : `- [${num}] ${title}`;
  });
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
    // 2026-09-28 weekly: the note name is the artifact's identity in the vault
    // folder. A weekly shipped as "AI.md" would sit next to a daily of the same
    // name — and on a manual re-run of a Friday it would overwrite the daily
    // rather than sit beside it. An explicit name (the alt channel) still wins.
    name = config.isWeekly ? "AI-周报" : "AI",
    model = config.synthModel,
    queryTemplate = config.aiQueryTemplate,
    title,
    synthTimeoutMs = config.synthTimeoutMs,
  } = {},
) {
  // 2026-09-28 weekly: the weekly query template carries {start} ~ {end} instead
  // of {date}, so a search that only substituted {date} would have sent the
  // literal string "{start}" to the model. Both placeholders are substituted
  // unconditionally — a daily template simply has no {start}/{end} to expand.
  const ai = (queryTemplate || "今天{date}最新的AI资讯和大模型动态")
    .replace(/\{date\}/g, config.date)
    .replace(/\{start\}/g, config.windowStartDate ?? config.date)
    .replace(/\{end\}/g, config.windowEndDate ?? config.date);
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
  const periodWords = reportPeriodWords(config.reportMode);
  for (const [label, arr, errKey] of [
    ["linux.do", linuxdoSources, "linuxdoError"],
    ["nodeseek", nodeseekSources, "nodeseekError"],
    ["v2ex", v2exSources, "v2exError"],
    [periodWords.hard, dailySources, "dailySourcesError"],
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
      continue;
    }
    // Same-day hard sources, per-provider shape: { hackernews: {count, sample},
    // arxiv: {...}, "google-ai": {...} }. These fetchers swallow their own
    // transport errors and return [], which is exactly why this shape exists —
    // without it a full outage of the daily hard sources printed a clean ✅
    // while the report quietly rested on forum posts alone.
    //
    // 2026-09-28 H1: a starved source is NOT a collection failure. It fetched
    // fine and the recency window emptied it, so labelling that "N 项采集失败"
    // sends the reader looking at the network instead of at the calendar. The
    // reason is carried through and named.
    degradedSources.push(
      ...formatDailySourceDiagnostics(arr?.dailyDiagnostics, label, periodWords.starved),
    );
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
  // 2026-09-26 review P2: tag provenance BEFORE dedup instead of back-matching by
  // URL afterwards. dedupeAndNormalizeSources keeps the cluster member with the
  // richest snippet, which is often a linux.do card rather than the daily one — so
  // a URL-set intersection silently stopped counting that day's material and could
  // push an adequately-stocked day under the 低素材 threshold, making the report
  // describe itself as stale when it wasn't. The representative's spread
  // ({ ...rep }) carries the flag, so a fold unions provenance correctly.
  const primarySources = [
    ...(dailySources || []).map((s) => ({ ...s, fromDaily: true })),
    ...(generalSources || []),
  ];
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
  // Recency gate: sources carrying a publishedAt (HN/36kr/arXiv) older than the
  // material window are dropped; timestamp-less sources (tavily/firecrawl) pass through.
  // The dropped count is surfaced in the report header as a material-window note.
  const { sources, dropped: recencyDropped } = filterByRecency(deduped, config.date, materialWindow(config));
  const investigation = await investigateIfEnabled(sources, config);
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
    const synthSources = investigation.sources;
    const synthQuery = investigation.preamble ? `${ai}\n\n${investigation.preamble}` : ai;
    const runOneShot = (m, instruction) =>
      synthesizeFromSources({
        query: synthQuery,
        date: config.date,
        sources: synthSources,
        model: m,
        maxTokens: config.synthMaxTokens,
        timeoutMs: synthTimeoutMs,
        reportMode: config.reportMode,
        instruction,
      });
    try {
      bodyText = geminiLoop
        ? await synthesizeWithWebSearch({
            query: synthQuery,
            date: config.date,
            sources: synthSources,
            model,
            maxTokens: config.synthMaxTokens,
            timeoutMs: synthTimeoutMs,
            maxSearchRounds: config.aiAltGeminiMaxRounds,
            reportMode: config.reportMode,
            searchImpl: (q) => gemSearch(q, config),
          })
        : await runOneShot(model);
      synthesized = true;
    } catch (e) {
      // Main writer failed (e.g. a slow reasoning model that 524s over the
      // gateway's ~120s Cloudflare cap). Retry the one-shot synthesis once with
      // the configured fallback model so the daily report still completes. The
      // gemini web_search loop is skipped here — it has its own bounded loop.
      // The stdout summary only carries the error code, so the full detail
      // (status + body snippet) must land in stderr (launchd/task log) — this
      // was the 2026-10-02 weekly outage's diagnosability gap.
      console.error(
        `[ai-news] synthesis failed (writer ${model}): code=${e?.code || "?"} status=${e?.status ?? "?"} ${redactSecrets(String(e?.message || e))}`,
      );
      const fb = config.synthFallbackModel;
      if (!geminiLoop && fb && fb !== model) {
        try {
          bodyText = await runOneShot(fb);
          synthesized = true;
          synthFellBack = true;
          synthFallbackFrom = model;
          synthError = null;
        } catch (e2) {
          console.error(
            `[ai-news] synthesis failed (fallback ${fb}): code=${e2?.code || "?"} status=${e2?.status ?? "?"} ${redactSecrets(String(e2?.message || e2))}`,
          );
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
  // Period-neutral in wording only where it must be: the daily string is
  // asserted verbatim by the blog-draft test and is what ships today, so the
  // branch is confined to the weekly.
  const synthFailedNote = synthAttemptedAndFailed
    ? `> ⚠️ **综合失败（${synthError?.code || "unknown"}）**：以下为未经来源核实的模型原始回答，可能与${config.reportMode === "weekly" ? "本周" : "当日"}事实不符，请谨慎阅读。\n\n`
    : "";

  const weekly = config.reportMode === "weekly";
  const fm = frontMatter({
    date: config.date,
    // frontMatter skips null fields, so a daily note keeps exactly the keys it
    // shipped with. The weekly needs the span: its H1 and body describe seven
    // days, and `date` alone (the Friday) would misdate every source in it.
    date_range: weekly ? config.windowLabel : null,
    updated: new Date().toISOString(),
    tags: [weekly ? "周报" : "日报", "AI"],
    days_dropped: daysDropped,
  });

  // Material-window counts must reflect what the model ACTUALLY received: merge
  // (URL-dedup + caps), event-cluster folding and the recency gate all shrink the
  // raw fetch — counting the raw fetch overstated "当日素材" and could suppress
  // the low-material warning (2026-09-25 review). Count the survivors that carry
  // the provenance flag stamped on them before the fold (see primarySources),
  // not a URL back-match: a cluster's representative can be a forum card, which
  // made the daily card silently stop counting (2026-09-26 review).
  // 2026-09-27 review B2: recency now decides, so a same-day forum post counts
  // even when no hard source survived — see countDailySources.
  const shownSources = investigation.sources;
  const dailyCount = countDailySources(shownSources, config.date, materialWindow(config));
  const genericCount = Math.max(0, sources.length - dailyCount);
  const header =
    config.reportStrictDaily !== false
      ? buildMaterialWindowHeader({
          dailyCount,
          genericCount,
          recencyDropped,
          mode: config.reportMode,
        })
      : "";

  // Append reference sources section at the bottom. The `[N]` markers in the body
  // index the FULL source list, so the selection carries each source's own number
  // (selectCitedSources) and the renderer prints that number rather than its own
  // position. With no [N] markers (fallback/degraded path) every source is
  // listed, numbered by position.
  // 2026-09-28: de-cluster BEFORE the citation scan, never after. The
  // reference list is built from the same string the body is rendered from, so
  // splitting a bullet afterwards would move text out from under a [N] the
  // scan had already resolved. Doing it here means the markers and the prose
  // stay in the same state.
  const bodyTextChecked = await enforceOneTopicPerBullet(bodyText || "", {
    topics: investigation.topics,
    sources: shownSources,
    retry: investigation.topics?.length
      ? (bullet) => retryBullet(bullet, (instruction) => runOneShot(model, instruction))
      : undefined,
  });
  const bodyTextTightened = splitOverMergedBullets(bodyTextChecked);
  // 2026-09-28 weekly: the cap of 30 is a reading-budget sized for a day's
  // worth of citations. A week's body cites proportionally more, and truncating
  // the tail would drop the very sources a later [N] points at — the reference
  // list would stop resolving mid-note. Weekly doubles it.
  const citedSources = selectCitedSources(shownSources, bodyTextTightened);
  const refLines = buildReferenceLines(citedSources, undefined, weekly ? 60 : 30);
  const refSection = refLines.length
    ? `\n\n---\n\n### 参考来源\n\n${refLines.join("\n")}`
    : "";

  const body = [
    fm,
    "",
    title ?? (weekly ? `# AI 热点周报 · ${config.windowLabel}` : `# AI 热点 · ${config.date}`),
    "",
    header,
    synthFailedNote,
    bodyTextTightened || "（模型未返回正文内容）",
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
    sourceCount: shownSources.length,
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
  const investigationNote = investigation.note ? `；${investigation.note}` : "";
  const summaryLine = `${summary}${investigationNote}${
    degradedSources.length ? `；⚠️ 部分来源不可用：${degradedSources.join("、")}` : ""
  }`;

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
    sourceCount: shownSources.length,
    linuxdoCount,
    nodeseekCount,
    v2exCount,
    // Reuse the sanitized source set for the AI poster headlines.
    sources: shownSources,
    // Poster/mirror alignment: the poster renders the sources the article
    // actually cited, so the poster is a visualization of the article rather
    // than a different (forum-first) source set. Falls back to the list the
    // model was shown when the body carried no [N] citations.
    // NOTE: plain source objects, not the {n, source} pairs — collectAiHeadlines
    // in image-gen.mjs reads `source.title` directly, so wrapping them would
    // silently empty the poster. The poster renders rows positionally and never
    // prints a [N] of its own, so it does not need the numbers.
    posterSources: citedSources.length ? citedSources.map((c) => c.source) : shownSources,
    // Raw linuxdo news/34 cards for auxiliary materials (all today's posts, no
    // AI filter, no cap). Written to a separate file by run.mjs.
    linuxdoRaw: linuxdoSources?.linuxdoRaw || [],
    investigation: investigation.stats,
  };
}

// Off by default. When on, A/B topics are investigated and D-grade cards leave
// the synthesis input. A thrown search returns the original cards with ok:false,
// so the summary cannot stay a clean success.
export async function investigateIfEnabled(sources, config, deps = {}) {
  if (!config?.topicInvestigation) {
    // Still group by URL/cluster so a merged [1, 2, 3] can be split even when
    // nobody investigated. Search is not called.
    return { sources, preamble: "", note: "", stats: null, topics: topicize(sources), ok: true };
  }
  const graded = gradeTopics(topicize(sources), { date: config.date });
  const { topics, capped } = applyGradeCap(graded, { mode: config.reportMode });
  const search = deps.search || defaultSearch(config);
  const run = deps.investigate || investigateTopics;
  let result;
  try {
    result = await run(topics, {
      search,
      date: config.date,
      cacheDir: config.cacheDir,
    });
  } catch {
    return {
      sources,
      preamble: "",
      note: "⚠️ 主题调查失败，已退回卡片综合",
      stats: null,
      topics: null,
      ok: false,
    };
  }
  const added = [];
  const seen = new Set(sources.map((s) => s.url).filter(Boolean));
  for (const topic of result.topics) {
    for (const extra of topic.memo?.addedSources || []) {
      if (!extra?.url || seen.has(extra.url)) continue;
      seen.add(extra.url);
      added.push({ url: extra.url, title: extra.title || extra.url, provider: "topic-investigation" });
    }
  }
  const bodyCards = result.topics
    .filter((t) => t.grade !== "D")
    .flatMap((t) => t.cards);
  const demotedBudget = result.topics.filter((t) => t.demoted === "investigate-budget").length;
  const invalid = result.topics.filter((t) => t.demoted === "investigate-invalid-json").length;
  const counts = countGrades(result.topics);
  const note = [
    `topics: ${result.topics.length}（A${counts.A} B${counts.B} C${counts.C} D${counts.D}）`,
    `investigated: ${result.stats.investigated}/${result.stats.eligible}，搜索 ${result.stats.searches} 次`,
    capped.length ? `topic-cap: ${capped.length}` : "",
    demotedBudget ? `investigate-budget: ${demotedBudget}` : "",
    invalid ? `investigate-invalid-json: ${invalid}` : "",
  ].filter(Boolean).join("；");
  return {
    sources: [...(bodyCards.length ? bodyCards : sources), ...added],
    preamble: renderInvestigationInput(result.topics),
    note,
    stats: result.stats,
    topics: result.topics,
    ok: true,
  };
}

async function retryBullet(bullet, runOneShot) {
  // No second gateway call with a fabricated source. The same synthesizer that
  // wrote the body is asked to keep one topic; if it is unavailable, or it
  // returns the same crossing bullet, the caller drops the bullet.
  if (typeof runOneShot !== "function") return "";
  try {
    return await runOneShot(
      `下面这一条要点写了两件事。改写成一条，只留其中一件，引用只保留这件事的编号。\n\n${bullet}`,
    );
  } catch {
    return "";
  }
}

function defaultSearch(config) {
  return async (query) => {
    const result = await runSearch(query, config, { days: config.days, extra: config.extra });
    const cards = result?.sources?.extra?.length ? result.sources.extra : result?.sources?.merged || [];
    if (!Array.isArray(cards)) {
      const err = new Error("topic search returned a non-list");
      err.code = "investigate-invalid-json";
      throw err;
    }
    return cards
      .filter((c) => c && c.url && c.title)
      .map((c) => ({ value: c.title, url: c.url, title: c.title }));
  };
}

function countGrades(topics) {
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  for (const topic of topics) if (topic.grade in counts) counts[topic.grade] += 1;
  return counts;
}
