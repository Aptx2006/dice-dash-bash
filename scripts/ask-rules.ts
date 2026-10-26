import { answerQuestion } from '../server/rag/coach.ts'

const question = process.argv.slice(2).join(' ') || '瞬移到终点会立刻结算吗？'
const result = await answerQuestion(question)
console.log(JSON.stringify(result.output, null, 2))
if (result.output.status === 'unavailable') process.exitCode = 1
