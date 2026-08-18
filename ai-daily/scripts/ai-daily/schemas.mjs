// ai-daily schemas — 与 workflow 内逐字节一致（WRITE_RESULT_SCHEMA 已随 mdWriter 代理删除）。
// 真源；build.mjs 剥 export inline 进 workflow。

export const DISCOVER_SCHEMA = {
  type: 'object', required: ['urls', 'noNews'],
  properties: {
    // urlsMax 放宽到 10 供合组媒体代理使用（单板代理由 prompt 限 6）；board 为媒体组必填的归属板块。
    urls: { type: 'array', maxItems: 10, items: {
      type: 'object', required: ['url', 'title', 'found_via', 'date'],
      properties: { url: { type: 'string' }, title: { type: 'string' }, found_via: { type: 'string' }, date: { type: 'string' }, board: { type: 'string' } },
    }},
    noNews: { type: 'array', items: { type: 'string' } },
    nearWindow: { type: 'array', items: { type: 'object', required: ['name', 'note'], properties: { name: { type: 'string' }, date: { type: 'string' }, note: { type: 'string' } } } },
    majorOutOfWindow: { type: 'array', items: { type: 'object', required: ['name', 'date', 'note'], properties: { name: { type: 'string' }, date: { type: 'string' }, note: { type: 'string' } } } },
    degraded: { type: 'boolean' },
  },
}
// 批量 Harvest schema：一个代理可覆盖多 feed，每条条目带 feed 字段（来源 Feed URL，原样回填）供归栈。
export const HARVEST_SCHEMA = {
  type: 'object', required: ['entries', 'recent'],
  properties: {
    entries: { type: 'array', maxItems: 100, items: {
      type: 'object', required: ['date', 'title', 'url'],
      properties: { date: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' }, feed: { type: 'string' } },
    }},
    recent: { type: 'array', maxItems: 30, items: {
      type: 'object', required: ['date', 'title', 'url', 'note'],
      properties: { date: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' }, note: { type: 'string' }, feed: { type: 'string' } },
    }},
    failed: { type: 'boolean' },
  },
}
export const EXTRACT_SCHEMA = {
  type: 'object', required: ['claims', 'sourceQuality'],
  properties: {
    sourceQuality: { enum: ['primary', 'secondary', 'blog', 'forum', 'unreliable'] },
    publishDate: { type: 'string' },
    claims: { type: 'array', maxItems: 3, items: {
      type: 'object', required: ['claim', 'quote', 'importance'],
      properties: { claim: { type: 'string' }, quote: { type: 'string' }, importance: { enum: ['central', 'supporting', 'tangential'] } },
    }},
  },
}
export const VERDICT_SCHEMA = {
  type: 'object', required: ['refuted', 'evidence', 'confidence'],
  properties: {
    refuted: { type: 'boolean' },
    evidence: { type: 'string' },
    confidence: { enum: ['high', 'medium', 'low'] },
  },
}
export const REPORT_SCHEMA = {
  type: 'object', required: ['oneLiner', 'execSummary', 'sections', 'caveats', 'openQuestions'],
  properties: {
    oneLiner: { type: 'string' },
    execSummary: { type: 'string' },
    sections: { type: 'array', items: {
      type: 'object', required: ['board', 'title', 'items'],
      properties: {
        board: { type: 'string' }, title: { type: 'string' },
        items: { type: 'array', items: {
          type: 'object', required: ['title', 'summary', 'confidence', 'sources'],
          properties: {
            title: { type: 'string' }, summary: { type: 'string' }, confidence: { enum: ['high', 'medium', 'low'] },
            sources: { type: 'array', items: { type: 'string' } }, vote: { type: 'string' },
          },
        }},
      },
    }},
    caveats: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
}
