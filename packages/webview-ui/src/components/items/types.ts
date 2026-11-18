import type { Item } from '@harness-deck/shared';

export type Of<K extends Item['kind']> = Extract<Item, { kind: K }>;
