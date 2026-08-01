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
].join("\n");

// Expected parsed + sorted (desc by starsToday) rows. ghostowner/no-today is
// filtered out (no stars today). starsTotal must NOT pick up "2026" or "2" from
// numsy-pkg's description. Order by starsToday desc: 1421, 1022, 945, 857, 555.
export const EXPECTED_FIXTURE_ROWS = [
  { repo: "virgiliojr94/book-to-skill", starsToday: 1421, starsTotal: 12709, description: "Turn any technical book PDF into a Claude Code skill." },
  { repo: "pascalorg/editor", starsToday: 1022, starsTotal: 19553, description: "Create and share 3D architectural projects." },
  { repo: "paperswithbacktest/awesome-systematic-trading", starsToday: 945, starsTotal: 10379, description: "Open-source systematic trading backtest library." },
  { repo: "affaan-m/ECC", starsToday: 857, starsTotal: 235547, description: "Some repo with no language line below" },
  { repo: "numsy-pkg/release-notes", starsToday: 555, starsTotal: 8401, description: "Changelog for the 2026 release of numsy, version 2." },
];
