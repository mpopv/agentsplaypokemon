interface Sequenced {
  sequence: number;
}

export interface HistoryPage<T> {
  items: T[];
  nextBefore: number | null;
  hasMore: boolean;
}

export function makeHistoryPage<T extends Sequenced>(
  descendingRows: T[],
  pageSize: number
): HistoryPage<T> {
  const hasMore = descendingRows.length > pageSize;
  const items = descendingRows.slice(0, pageSize).reverse();
  return {
    items,
    nextBefore: hasMore ? (items[0]?.sequence ?? null) : null,
    hasMore
  };
}
