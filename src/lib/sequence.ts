interface Sequenced {
  sequence: number;
}

export function mergeBySequence<T extends Sequenced>(current: T[], incoming: T[]): T[] {
  if (incoming.length === 0) return current;
  const bySequence = new Map(current.map((item) => [item.sequence, item]));
  for (const item of incoming) bySequence.set(item.sequence, item);
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}
