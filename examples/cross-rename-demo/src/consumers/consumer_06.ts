import { authenticate } from "../services/user";

export function runConsumer06(): boolean {
  return authenticate("demo-06");
}
