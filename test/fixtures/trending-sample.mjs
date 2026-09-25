// Minimal but realistic sample of grok-search fetch.js `--provider direct` output
// for https://github.com/trending?since=daily. Mirrors the real per-repo block:
//
//   owner /
//   name
//   description…
//   <language>
//   <totalStars>      ← e.g. "19,553"
//   <forks>           ← e.g. "2,591"
//   Built by
//   <NNN> stars today
//
// Trimmed to a few repos + a noisy header so the parser must skip non-repo lines.
// Repo #2 ("numsy-pkg") deliberately puts a bare number "2026" in its description
// line to guard against description numbers polluting starsTotal (the P2 fix).
// Repo "noisy-num/three-numbers" carries THREE bare numbers before "Built by":
// the layout is not the canonical block, so starsTotal/forks must stay null
// (2026-09-25 review). Repo "impossible-num/bad-total" parses a total (40) that
// is lower than its same-day delta (77) — an impossible value that must be
// nulled before publishing.

export const TRENDING_FIXTURE = [
  "# Trending repositories on GitHub today · GitHub",
  "",
  "Skip to content",
  "Navigation Menu",
  "-",
  "virgiliojr94 /",
  "book-to-skill",
  "Turn any technical book PDF into a Claude Code skill.",
  "Python",
  "12,709",
  "1,414",
  "Built by",
  "1,421 stars today",
  "Star",
  "",
  "pascalorg /",
  "editor",
  "Create and share 3D architectural projects.",
  "TypeScript",
  "19,553",
  "2,591",
  "Built by",
  "1,022 stars today",
  "Sponsor",
  "Star",
  "",
  "numsy-pkg /",
  "release-notes",
  "Changelog for the 2026 release of numsy, version 2.",
  "Go",
  "8,401",
  "612",
  "Built by",
  "555 stars today",
  "Star",
  "",
  "affaan-m /",
  "ECC",
  "Some repo with no language line below",
  "235,547",
  "9,012",
  "Built by",
  "857 stars today",
  "",
  "notebook-org /",
  "nb-demo",
  "Interactive notebook demos for data science.",
  "Jupyter Notebook",
  "5,432",
  "321",
  "Built by",
  "700 stars today",
  "Star",
  "",
  "ghostowner /",
  "no-today",
  "This repo has no 'stars today' line, so it should be filtered out.",
  "Rust",
  "500",
  "40",
  "Built by",
  "",
  "paperswithbacktest /",
  "awesome-systematic-trading",
  "Open-source systematic trading backtest library.",
  "Python",
  "10,379",
  "1,201",
  "Built by",
  "945 stars today",
  "Star",
  "",
  "lone-repo /",
  "no-desc",
  "Python", // ← no description: this <language> line must NOT be captured as description
  "1,234",
  "567",
  "Built by",
  "89 stars today",
  "Star",
  "",
  "impossible-num /",
  "bad-total",
  "Total below is smaller than the same-day delta, so attribution must be dropped.",
  "Go",
  "40",
  "12",
  "Built by",
  "77 stars today",
  "Star",
  "",
  "noisy-num /",
  "three-numbers",
  "Three bare numbers sit before Built by, so the layout is not canonical.",
  "Rust",
  "999",
  "888",
  "777",
  "Built by",
  "55 stars today",
  "Star",
].join("\n");

// Expected parsed + sorted (desc by starsToday) rows. ghostowner/no-today is
// filtered out (no stars today). starsTotal must NOT pick up "2026" or "2" from
// numsy-pkg's description. lone-repo/no-desc has NO description line, so its
// <language> line ("Python") must stay out of description (null) — the P2 fix.
// affaan-m/ECC has no language line (a bare number follows the description).
// notebook-org/nb-demo exercises a multi-word language label ("Jupyter
// Notebook") plus forks parsing (2026-09-25 Copilot review). impossible-num /
// bad-total must end with starsTotal null (40 < 77 sanity guard) but keeps its
// forks; noisy-num/three-numbers must end with starsTotal AND forks null (3
// bare numbers ≠ canonical 2-number block).
// Order by starsToday desc: 1421, 1022, 945, 857, 700, 555, 89, 77, 55.
export const EXPECTED_FIXTURE_ROWS = [
  { repo: "virgiliojr94/book-to-skill", starsToday: 1421, starsTotal: 12709, forks: 1414, description: "Turn any technical book PDF into a Claude Code skill.", language: "Python" },
  { repo: "pascalorg/editor", starsToday: 1022, starsTotal: 19553, forks: 2591, description: "Create and share 3D architectural projects.", language: "TypeScript" },
  { repo: "paperswithbacktest/awesome-systematic-trading", starsToday: 945, starsTotal: 10379, forks: 1201, description: "Open-source systematic trading backtest library.", language: "Python" },
  { repo: "affaan-m/ECC", starsToday: 857, starsTotal: 235547, forks: 9012, description: "Some repo with no language line below", language: null },
  { repo: "notebook-org/nb-demo", starsToday: 700, starsTotal: 5432, forks: 321, description: "Interactive notebook demos for data science.", language: "Jupyter Notebook" },
  { repo: "numsy-pkg/release-notes", starsToday: 555, starsTotal: 8401, forks: 612, description: "Changelog for the 2026 release of numsy, version 2.", language: "Go" },
  { repo: "lone-repo/no-desc", starsToday: 89, starsTotal: 1234, forks: 567, description: null, language: "Python" },
  { repo: "impossible-num/bad-total", starsToday: 77, starsTotal: null, forks: 12, description: "Total below is smaller than the same-day delta, so attribution must be dropped.", language: "Go" },
  { repo: "noisy-num/three-numbers", starsToday: 55, starsTotal: null, forks: null, description: "Three bare numbers sit before Built by, so the layout is not canonical.", language: "Rust" },
];
