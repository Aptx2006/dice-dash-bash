import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadKnowledge, retrieve, splitKnowledge } from '../server/rag/knowledge.ts'

test('知识库按完整标题切分，编号唯一，来源行号与正文对应', async () => {
  const chunks = await loadKnowledge()
  const source = await readFile(new URL('../knowledge/rules-v1.md', import.meta.url), 'utf8')
  const lines = source.split('\n')
  assert.equal(chunks.length, 20)
  assert.equal(new Set(chunks.map(chunk => chunk.id)).size, chunks.length)
  for (const chunk of chunks) {
    assert.equal(chunk.rulesVersion, 'local-v1')
    assert.equal(chunk.source, 'knowledge/rules-v1.md')
    const [start, end] = chunk.sourceLines
    const raw = lines.slice(start - 1, end).join('\n')
    assert.ok(raw.startsWith(`## ${chunk.id} | ${chunk.title}`))
    assert.ok(raw.includes(chunk.text.split('\n')[0]))
    assert.ok(chunk.text.includes('源码:'))
    assert.ok(chunk.keywords.length > 0)
  }
})

test('三条抽检规则保持完整条件和例外，没有被长度切断', async () => {
  const chunks = await loadKnowledge()
  assert.match(chunks.find(c => c.id === 'phase.end')!.text, /再次使用“结束”才交出行动权/)
  assert.match(chunks.find(c => c.id === 'tool.teleport')!.text, /不能是坑洞/)
  assert.match(chunks.find(c => c.id === 'terrain.danger')!.text, /经过毒气但最终未停在毒气上/)
  for (let index = 1; index < chunks.length; index++) {
    assert.ok(chunks[index - 1].sourceLines[1] < chunks[index].sourceLines[0])
  }
})

test('单规则问题检索正确，分数与命中词可检查', async () => {
  const chunks = await loadKnowledge()
  const hits = retrieve(chunks, '行动阶段按一次结束牌会立刻交出回合吗？')
  assert.equal(hits[0].chunk.id, 'phase.end')
  assert.ok(hits[0].score >= 2)
  assert.ok(hits[0].matchedTerms.includes('结束牌'))
})

test('多规则问题Top-3包含冲刺、瞬移和终点结算', async () => {
  const chunks = await loadKnowledge()
  const ids = retrieve(chunks, '3点移动牌先用冲刺变成几点？最后瞬移到终点能本回合获胜吗？').map(hit => hit.chunk.id)
  assert.deepEqual(new Set(ids), new Set(['tool.sprint', 'tool.teleport', 'result.finish']))
})

test('无依据、含糊指代、空问题和非法k不返回伪相关片段', async () => {
  const chunks = await loadKnowledge()
  for (const question of ['金币兑换现金比例和提现手续费', '这个怎么用', '这个道具怎么用？', '']) {
    assert.deepEqual(retrieve(chunks, question), [])
  }
  assert.deepEqual(retrieve(chunks, '瞬移', Number.NaN), [])
  assert.deepEqual(retrieve(chunks, '瞬移', 0), [])
})

test('知识库版本、乱码、重复编号与缺元数据会被拒绝', () => {
  assert.throws(() => splitKnowledge('## phase.roll | 投骰\n关键词: 投骰\n源码: x\n内容'), /规则版本/)
  assert.throws(() => splitKnowledge('规则版本: v1\n\uFFFD'), /乱码/)
  const block = '## phase.roll | 投骰\n关键词: 投骰\n源码: x\n完整内容\n'
  assert.throws(() => splitKnowledge('规则版本: v1\n' + block + block), /重复/)
  assert.throws(() => splitKnowledge('规则版本: v1\n## phase.roll | 投骰\n无元数据'), /缺少/)
})
