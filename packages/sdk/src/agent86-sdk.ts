import { builder, type OpBatchBuilder } from "./builder.js";
import { mergeSearchCriteria, search, type SearchOptions } from "./search.js";
import type { Agent86Transport } from "./transport.js";
import type { SearchCriteria, UnitRef } from "./types.js";

export interface Agent86SdkOptions {
  transport: Agent86Transport;
}

/**
 * Thin façade over transport-backed helpers (`search`, fluent `builder`).
 */
export class Agent86Sdk {
  constructor(private readonly options: Agent86SdkOptions) {}

  get transport(): Agent86Transport {
    return this.options.transport;
  }

  builder(): OpBatchBuilder {
    return builder(this.options.transport);
  }

  search(
    criteria: SearchCriteria,
    opts: Omit<SearchOptions, "transport">,
  ): Promise<UnitRef[]> {
    return search(criteria, { ...opts, transport: this.options.transport });
  }

  mergeSearchCriteria(base: SearchCriteria, override: Partial<SearchCriteria>): SearchCriteria {
    return mergeSearchCriteria(base, override);
  }
}
