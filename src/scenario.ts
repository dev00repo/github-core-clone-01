// The scenario identity derivation.
//
// The suite builds every name it uses from one fixed seed (SCENARIO_SEED) through
// the PRNG below (FNV-1a 64-bit label mixing, splitmix64 finalizer, xorshift64*).
// The entry re-implements that derivation so it knows the login its bearer token
// names — the viewer — without any extra channel. The seed is a constant of the
// sealed suite, so the derived values are the same in practice and in the final.
//
// Expected (verified against the kit's own buildScenario()):
//   viewer   adaiversen   (id 1000)
//   stranger olgabauer    (id 1002)
//   org      faint-meadow-org
//   first seeded repo (repoPrefix) amber-thistle

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

/** FNV-1a, 64-bit: a label's stable seed contribution. */
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

/** splitmix64's finalizer: a seeded value with every bit mixed into every other. */
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** xorshift64*: three shifts and one multiply, seeded from a bigint. */
class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  /** An integer in [0, maxExclusive), unbiased by rejection. */
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}

export interface ScenarioIdentity {
  viewer: string;
  teammate: string;
  stranger: string;
  org: string;
}

/**
 * Derive the scenario's identities from the fixed seed. Only the 'users' and
 * 'org' streams are needed: users[0] is the viewer, users[2] the stranger,
 * and the org name comes from the 'org' stream (adjective-noun-org).
 */
export function deriveScenario(): ScenarioIdentity {
  const seedFor = (label: string): bigint => mix64(SCENARIO_SEED ^ fnv1a64(label));
  const usersRng = new Rng(seedFor('users'));
  const used = new Set<string>();
  const logins: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = usersRng.pick(FIRST_NAMES);
    const last = usersRng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    logins.push(login);
  }
  const orgRng = new Rng(seedFor('org'));
  const adjectives = [
    'amber', 'brisk', 'calm', 'crisp', 'eager', 'faint', 'gentle', 'happy', 'idle', 'jolly', 'keen', 'lively',
    'mellow', 'nimble', 'open', 'plain', 'quick', 'quiet', 'rapid', 'soft', 'steady', 'tidy', 'upbeat',
    'vivid', 'warm', 'witty', 'young', 'zesty',
  ];
  const nouns = [
    'acorn', 'badger', 'canyon', 'cedar', 'comet', 'coral', 'delta', 'ember', 'falcon', 'glade', 'harbor',
    'indigo', 'juniper', 'kettle', 'lantern', 'meadow', 'nebula', 'orchid', 'pebble', 'quartz', 'raven',
    'saffron', 'thistle', 'umber', 'violet', 'willow', 'yarrow', 'zephyr',
  ];
  const org = `${orgRng.pick(adjectives)}-${orgRng.pick(nouns)}-org`;
  return { viewer: logins[0], teammate: logins[1], stranger: logins[2], org };
}
