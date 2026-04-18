import { authenticate } from "../services/user";

export function runConsumer07(): boolean {
  return authenticate("demo-07");
}
