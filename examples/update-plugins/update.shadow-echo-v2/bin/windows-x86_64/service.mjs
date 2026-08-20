import readline from 'node:readline'

const input = readline.createInterface({ input: process.stdin })
input.on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'shutdown') process.exit(0)
  if (message.id !== undefined) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.params })}\n`)
  }
})
