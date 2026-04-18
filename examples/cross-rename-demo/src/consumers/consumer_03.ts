import { authenticate } from "../services/user";

export function runConsumer03(): boolean {
  return authenticate("demo-03");
}
