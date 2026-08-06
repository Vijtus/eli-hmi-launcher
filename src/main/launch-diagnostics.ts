import type { MaterializedProcess } from "./config";

export type ResolvedLaunchDiagnostics = {
  resolvedCommand: string;
  resolvedArgs: string[];
};

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  const text = String(error).trim();
  return text || "Unknown launch failure.";
}

export class LaunchDiagnosticError extends Error {
  readonly resolvedCommand: string;
  readonly resolvedArgs: string[];
  readonly originalError: unknown;

  constructor(error: unknown, diagnostics: ResolvedLaunchDiagnostics) {
    super(errorMessage(error));
    this.name = "LaunchDiagnosticError";
    this.resolvedCommand = diagnostics.resolvedCommand;
    this.resolvedArgs = [...diagnostics.resolvedArgs];
    this.originalError = error;
  }
}

export function attachLaunchDiagnostics(
  error: unknown,
  materialized: Pick<MaterializedProcess, "command" | "args">,
): LaunchDiagnosticError {
  if (error instanceof LaunchDiagnosticError) {
    return error;
  }
  return new LaunchDiagnosticError(error, {
    resolvedCommand: materialized.command,
    resolvedArgs: [...(materialized.args ?? [])],
  });
}

export function diagnosticsFromError(error: unknown): ResolvedLaunchDiagnostics | undefined {
  if (!(error instanceof LaunchDiagnosticError)) {
    return undefined;
  }
  return {
    resolvedCommand: error.resolvedCommand,
    resolvedArgs: [...error.resolvedArgs],
  };
}
