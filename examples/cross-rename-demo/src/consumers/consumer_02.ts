import { authenticate } from "../services/user";

export function runConsumer02(): boolean {
  return authenticate("demo-02");
}
