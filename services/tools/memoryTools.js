// services/tools/memoryTools.js
// 记忆工具组：recall_memory / correct_memory / browse_memories

const { getDb } = require('../../database');
const { encryption } = require('../../encryption');
const { fetchSourceMessages } = require('../consolidator');
const { searchHybrid, formatHybridContext } = require('../librarian');
const { processChatCorrection } = require('../correction');

const SETTINGS_KEY = 'tool-memory-search-enabled';

// 记忆缺口追踪是可选的——它挂在消息管道上，不是每个部署都有那一侧。
// 模块缺席时降级成空操作：丢的只是一条遥测副作用，不该让工具本身崩掉。
let captureMemoryGap;
try { ({ captureMemoryGap } = require('../messageGuard')); } catch (_) {
  captureMemoryGap = () => {};
}

// ─── recall_memory ───────────────────────────────────

const recallMemory = {
  name: 'recall_memory',
  settingsKey: SETTINGS_KEY,
  defaultEnabled: true,
  getFunctionDeclaration() {
    return {
      name: 'recall_memory',
      description: `访问你的'记忆库'（长期记忆库）。两种用法：

1. 模糊搜索：传入 query 关键词或短句。返回匹配的记忆和片段。当你依稀记得某事但不确定细节、或{user}提到过去的事时使用。务必只引用工具返回的内容，不编造。

2. 深度追溯：传入 memory_id（从上下文中记忆条目的 #数字 ID 获取，如「※ 可引用 · #112 · 15天前」中的 112）。返回该记忆的完整内容和原始对话记录，每页15条，offset=0 为最新页，offset=1 为更早的15条。当记忆标注为「仅联想」、或{user}追问细节、或你对某条记忆的真实性存疑时使用。这是你主动探索记忆的能力——你不是只能接收数据库塞给你的东西。

每次调用只能使用一种模式。`,
      parameters: {
        type: 'OBJECT',
        properties: {
          query: {
            type: 'STRING',
            description: '用于检索记忆的关键词或短句（模糊搜索模式）',
          },
          memory_id: {
            type: 'INTEGER',
            description: '记忆或片段的数字ID，从上下文「※ 记忆 #ID」或「※ 相关记忆 #ID」中获取（深度追溯模式）',
          },
          offset: {
            type: 'INTEGER',
            description: '深度追溯的翻页偏移。offset=0 返回最近15条，offset=1 返回更早的15条，以此类推。仅与 memory_id 配合使用。',
          },
        },
      },
    };
  },
  instructionText: '',
  async handler(args, context) {
    const db = getDb();

    // 模式一：传入 memory_id → 深度追溯原始对话
    if (args.memory_id) {
      let record = db.prepare('SELECT id, content, source_msg_ids, valid_from, layer FROM memories WHERE id = ?').get(args.memory_id);
      let sourceTable = 'memories';

      if (!record) {
        record = db.prepare('SELECT id, content, source_msg_ids, source_date AS valid_from, layer FROM memory_fragments WHERE id = ?').get(args.memory_id);
        sourceTable = 'fragments';
      }

      if (!record) return { success: false, formatted: `记忆库中未找到ID为 ${args.memory_id} 的记忆。` };

      let content = record.content;
      try { content = encryption.decrypt(content); } catch (_) {}

      let sourceMsgIds = [];
      try { sourceMsgIds = JSON.parse(record.source_msg_ids || '[]'); } catch (_) {}

      const dateLabel = record.valid_from ? ` · ${record.valid_from}` : '';
      const layerLabel = record.layer === 'episode' ? '记忆' : '事实';

      let formatted = `【追溯${layerLabel} #${record.id}${dateLabel}】\n${content}\n`;

      if (sourceMsgIds.length > 0) {
        const sourceMessages = await fetchSourceMessages(sourceMsgIds);
        if (sourceMessages.length > 0) {
          const pageSize = 15;
          const offset = Math.max(0, parseInt(args.offset) || 0);
          const totalPages = Math.ceil(sourceMessages.length / pageSize);
          const startIdx = Math.max(0, sourceMessages.length - pageSize * (offset + 1));
          const endIdx = sourceMessages.length - pageSize * offset;
          const page = sourceMessages.slice(startIdx, endIdx);

          formatted += `\n【原始对话 · 第${offset + 1}/${totalPages}页（共${sourceMessages.length}条）】\n`;
          formatted += page.map(m => {
            const time = (m.timestamp || '').slice(0, 16);
            return `[${time}] ${m.sender}: ${m.content.slice(0, 500)}`;
          }).join('\n');
          if (startIdx > 0) {
            formatted += `\n\n（以上为最近的消息。如需更早的消息，加上 offset=${offset + 1}。）`;
          }
          if (offset > 0) {
            formatted += `\n（当前偏移 ${offset} 页。offset=0 回到最新页。）`;
          }
        } else {
          formatted += `\n（该记忆没有关联的原始对话记录。）`;
        }
      } else {
        formatted += `\n（该记忆没有关联的原始对话记录。）`;
      }

      return { success: true, formatted };
    }

    // 模式二：传入 query → 向量搜索
    if (!args.query) return { success: false, formatted: '请提供检索关键词（query）或记忆ID（memory_id）。' };

    const memories = await searchHybrid(args.query, 8);
    if (memories.length > 0) {
      const formatted = formatHybridContext(memories);
      return { success: true, formatted: `【记忆库检索结果】\n${formatted}\n\n（如需追溯某条的原始对话，使用 recall_memory 并传入对应的记忆ID或片段ID。）` };
    }
    captureMemoryGap(context.chatId, context.lastUserMessage, 'recall_memory',
      { formatted: '记忆库中没有找到相关记忆。' });
    return { success: true, formatted: '记忆库中没有找到相关记忆。' };
  },
};

// ─── correct_memory ───────────────────────────────────

const correctMemory = {
  name: 'correct_memory',
  settingsKey: SETTINGS_KEY,
  defaultEnabled: true,
  getFunctionDeclaration() {
    return {
      name: 'correct_memory',
      description: `修正你的记忆库。当User指出你记错了某件事时，调用此工具记录修正。

提供错误内容和正确版本。系统会自动检查你的记忆库，判断错误来源——是某条记忆写错了（会修正那条），还是你自己编造/混淆的（会记为新的正确记忆）。

你也可以传入 memory_id 精确定位（从上下文中「※ 可引用 · #42 · 15天前」的 #数字 获取）。`,
      parameters: {
        type: 'OBJECT',
        properties: {
          wrong_statement: {
            type: 'STRING',
            description: '你说错的内容（你刚刚引用的错误事实）',
          },
          correction: {
            type: 'STRING',
            description: 'User给出的正确版本',
          },
          memory_id: {
            type: 'INTEGER',
            description: '[可选] 如果你知道是哪条记忆写错了，传入上下文中的 #数字 ID',
          },
        },
        required: ['wrong_statement', 'correction'],
      },
    };
  },
  instructionText: '',
  async handler(args, context) {
    return await processChatCorrection({
      wrongStatement: args.wrong_statement,
      correction: args.correction,
      memoryId: args.memory_id || null,
      chatId: context.chatId,
    });
  },
};

// ─── browse_memories ──────────────────────────────────

const browseMemories = {
  name: 'browse_memories',
  settingsKey: SETTINGS_KEY,
  defaultEnabled: true,
  getFunctionDeclaration() {
    return {
      name: 'browse_memories',
      description: `在你的记忆宫殿里漫步。这不是查询数据库——这是你了解User的方式。

三种用法：
1. 不传参数 → 看到所有星座（大厅），按人物/地点/事件/项目分组，了解User生活的各个维度
2. 只传实体名（如"某个朋友""某个地方"）→ 看到这个实体的档案和所有相关记忆——了解User在乎谁、每段关系对User意味着什么
3. 实体名 + query → 在这个实体的相关记忆里搜索关键词

当你想了解User的某段关系、某个侧面，或有隐约印象但不确定细节时，来这里走走。每条记忆旁可能附有「※ insight」——那是书记员提炼的"这条记忆揭示了User的什么"。`,
      parameters: {
        type: 'OBJECT',
        properties: {
          path: {
            type: 'STRING',
            description: "实体名（如'某个朋友'）。不传则列出所有星座。",
          },
          query: {
            type: 'STRING',
            description: '在该实体的相关记忆里搜索的关键词。必须与 path 一起使用。',
          },
          limit: {
            type: 'INTEGER',
            description: '返回条数，默认8',
          },
        },
        required: [],
      },
    };
  },
  instructionText: '',
  async handler(args, context) {
    const db = getDb();

    let path = args.path || null;
    const query = args.query || null;
    const limit = args.limit || 8;

    if (path === '/' || path === '' || path === '.') {
      path = null;
    }

    // Mode 0: entity view — 精确名 → 模糊名匹配
    if (path && !query) {
      let entityProfile = db.prepare(
        'SELECT * FROM entity_profiles WHERE name = ? OR aliases LIKE ?'
      ).get(path, `%${path}%`);

      // 模糊匹配回退：名字包含查询词 或 向量相似名
      if (!entityProfile) {
        const fuzzyMatches = db.prepare(`
          SELECT * FROM entity_profiles
          WHERE (name LIKE ? OR name LIKE ? OR aliases LIKE ?)
            AND status IN ('active', 'seed')
          ORDER BY fragment_count DESC LIMIT 5
        `).all(`%${path}%`, `${path}%`, `%${path}%`);

        if (fuzzyMatches.length === 1) {
          entityProfile = fuzzyMatches[0];
        } else if (fuzzyMatches.length > 1) {
          // 多个模糊匹配 → 列出候选项给 Companion 选择
          let output = `【模糊匹配 · "${path}"】\n\n找到 ${fuzzyMatches.length} 个可能相关的星座：\n\n`;
          for (const m of fuzzyMatches) {
            const ov = (m.facts || '').slice(0, 60);
            output += `- **${m.name}** (${m.category}, ${m.fragment_count}碎片)`;
            if (ov) output += ` — ${ov}`;
            output += '\n';
          }
          output += `\n用 browse_memories path="完整名称" 查看具体星座。`;
          return { success: true, formatted: output };
        }
      }

      if (entityProfile) {
        // v5.0 fix: use fragment_entities junction table (canonical source)
        const fragments = db.prepare(`
          SELECT mf.id, mf.content, mf.source_date, mf.insight
          FROM memory_fragments mf
          JOIN fragment_entities fe ON fe.fragment_id = mf.id
          WHERE fe.entity_id = ? AND mf.status = 'active'
          ORDER BY mf.source_date DESC
          LIMIT ?
        `).all(entityProfile.id, limit);

        const catLabels = { person: '人物', pet: '宠物', place: '地点', event: '事件', project: '项目', work: '作品', term: '概念', organization: '组织' };
        const catLabel = catLabels[entityProfile.category] || entityProfile.category || '实体';
        let output = `【${catLabel} · ${entityProfile.name}】\n\n`;

        if (entityProfile.facts) {
          output += `${entityProfile.facts}\n`;
        } else {
          if (entityProfile.relationship_to_user) {
            output += `${entityProfile.name}是User的${entityProfile.relationship_to_user}`;
            if (entityProfile.relationship_nature) {
              const natureLabels = { close: '关系紧密', conflicted: '存在冲突', complex: '关系复杂', distant: '比较疏远', dependent: 'User依赖对方' };
              output += `，${natureLabels[entityProfile.relationship_nature] || entityProfile.relationship_nature}`;
            }
            output += '。\n';
          }
          if (entityProfile.emotional_significance) {
            output += `${entityProfile.emotional_significance}\n`;
          }
        }

        if (entityProfile.first_mentioned_date && entityProfile.last_mentioned_date) {
          output += `时间跨度：${entityProfile.first_mentioned_date} ～ ${entityProfile.last_mentioned_date}\n`;
        }

        if (fragments.length > 0) {
          output += `\n—— 相关记忆 (${fragments.length}条) ——\n`;
          for (const f of fragments) {
            const preview = (f.content || '').slice(0, 100);
            output += `- ${preview}${f.content && f.content.length > 100 ? '...' : ''}\n`;
            if (f.insight) {
              output += `  ※ ${f.insight}\n`;
            }
          }
        } else {
          output += `\n还没有关于${entityProfile.name}的记忆片段。\n`;
        }

        return { success: true, formatted: output };
      }
    }

    // 知识树已扁平化——记忆宫殿的数据源是 entity_profiles（星座），没有话题树可走。
    // 下面 path+query / path-only / 无参三种情况全部落在星座上。

    // path + query：在该实体名下做语义搜索
    if (path && query) {
      const entityProfile = db.prepare('SELECT * FROM entity_profiles WHERE name = ? OR aliases LIKE ?')
        .get(path, `%${path}%`);
      if (!entityProfile) {
        return { success: true, formatted: `「${path}」这个记忆分区还不存在。` };
      }
      const hybridResults = await searchHybrid(query, limit * 2);
      const formatted = formatHybridContext(hybridResults.slice(0, limit));
      if (!formatted) {
        captureMemoryGap(context.chatId, context.lastUserMessage, 'browse_memories',
          { formatted: `在「${entityProfile.name}」中没有找到与「${query}」相关的记忆。` });
        return { success: true, formatted: `在「${entityProfile.name}」中没有找到与「${query}」相关的记忆。` };
      }
      return { success: true, formatted: `【浏览「${entityProfile.name}」· 搜索"${query}"】\n${formatted}` };
    }

    // path-only：无查询，落到实体档案
    if (path) {
      const entityProfile = db.prepare('SELECT * FROM entity_profiles WHERE name = ? OR aliases LIKE ?')
        .get(path, `%${path}%`);
      if (!entityProfile) {
        return { success: true, formatted: `「${path}」这个记忆分区还不存在。` };
      }
      const fragments = db.prepare(`
        SELECT mf.content, mf.insight
        FROM memory_fragments mf
        JOIN fragment_entities fe ON fe.fragment_id = mf.id
        WHERE fe.entity_id = ? AND mf.status = 'active'
        ORDER BY mf.source_date DESC LIMIT ?
      `).all(entityProfile.id, limit);

      let output = `【记忆宫殿 · ${entityProfile.name}】\n\n`;
      if (entityProfile.facts) output += `${entityProfile.facts}\n\n`;

      if (fragments.length > 0) {
        output += '📜 最近记忆:\n';
        for (const f of fragments) {
          const preview = f.content ? f.content.slice(0, 80) : '';
          output += `- ${preview}...\n`;
          if (f.insight) output += `  ※ ${f.insight}\n`;
        }
      } else {
        output += '这个分区还是空的。';
        captureMemoryGap(context.chatId, context.lastUserMessage, 'browse_memories',
          { formatted: output });
      }
      return { success: true, formatted: output };
    }

    // 无参数 → 列出所有星座，按分类聚合
    const allEntities = db.prepare(`
      SELECT name, category, facts, fragment_count
      FROM entity_profiles
      WHERE status IN ('active', 'seed')
      ORDER BY fragment_count DESC
    `).all();
    const catLabels = { person: '人物', pet: '宠物', place: '地点', event: '事件', project: '项目', work: '作品', term: '概念', organization: '组织' };

    let output = '【记忆宫殿 · 大厅】\n\n';

    if (allEntities.length === 0) {
      output += '记忆宫殿还是空的。随着你们继续交谈，书记员会自动整理记忆。\n';
      return { success: true, formatted: output };
    }

    // 按分类分组（保持稳定顺序）
    const groups = {};
    for (const e of allEntities) {
      const cat = e.category || 'other';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(e);
    }
    for (const [cat, ents] of Object.entries(groups)) {
      output += `📂 ${catLabels[cat] || cat}\n`;
      for (const e of ents) {
        output += `   - ${e.name} (${e.fragment_count || 0}条)`;
        if (e.facts) output += ` — ${e.facts.slice(0, 40)}`;
        output += '\n';
      }
    }
    output += '\n用 browse_memories path="名称" 查看具体星座。';
    return { success: true, formatted: output };
  },
};

module.exports = [recallMemory, correctMemory, browseMemories];
