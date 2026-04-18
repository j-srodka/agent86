import { authenticate } from "../services/user";

export function runConsumer08(): boolean {
  return authenticate("demo-08");
}
