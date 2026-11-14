import type {
  SessionRuntimeExtras,
  SessionRuntimeExtrasContributor,
  SessionRuntimeExtrasInput,
} from '@/shared/types.js';

const contributors = new Set<SessionRuntimeExtrasContributor>();

/**
 * Used by the threads module (register) and the Claude runtime (collect), so a
 * feature can add per-session tools and folders to a turn without the
 * providers module depending on it.
 */
export const sessionRuntimeExtrasService = {
  /** Adds a contributor; returns a function that removes it again. */
  register(contributor: SessionRuntimeExtrasContributor): () => void {
    contributors.add(contributor);
    return () => {
      contributors.delete(contributor);
    };
  },

  /** Merges every contributor's additions. A contributor that throws is skipped and logged. */
  collect(input: SessionRuntimeExtrasInput): SessionRuntimeExtras {
    const merged: SessionRuntimeExtras = {
      mcpServers: {},
      allowedTools: [],
      additionalDirectories: [],
      waitForApprovalIndefinitely: false,
    };
    for (const contributor of contributors) {
      try {
        const extras = contributor(input);
        if (!extras) continue;
        Object.assign(merged.mcpServers, extras.mcpServers ?? {});
        merged.allowedTools.push(...(extras.allowedTools ?? []));
        merged.additionalDirectories.push(...(extras.additionalDirectories ?? []));
        merged.waitForApprovalIndefinitely ||= Boolean(extras.waitForApprovalIndefinitely);
      } catch (error) {
        console.warn('[Session extras] A contributor failed and was skipped:', error);
      }
    }
    merged.allowedTools = [...new Set(merged.allowedTools)];
    merged.additionalDirectories = [...new Set(merged.additionalDirectories)];
    return merged;
  },
};
