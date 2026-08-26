export interface SecretBindings {
  SESSION_SIGNING_SECRET?: string;
  ADMIN_TOKEN?: string;
}

export type RuntimeEnv = Env & SecretBindings;
