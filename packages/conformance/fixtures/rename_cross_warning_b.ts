import { get } from "./rename_cross_warning_a";

type Box = { get: number };

export function useGet(): number {
  return get();
}
