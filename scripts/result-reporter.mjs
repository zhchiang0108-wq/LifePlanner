export default async function* reporter(events) {
  for await (const { type, data } of events) {
    if (type === 'test:pass' || type === 'test:fail') {
      yield JSON.stringify({ name: data.name, passed: type === 'test:pass' && !data.skip && !data.todo,
        code: data.details?.error?.cause?.code, message: data.details?.error?.cause?.message }) + '\n';
    }
  }
}
