import { authenticate } from "../services/user";

export function runConsumer01(): boolean {
  return authenticate("demo-01");
}
