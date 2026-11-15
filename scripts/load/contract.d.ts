export type WorkloadQuery = {
  kind: "people" | "teams";
  skill?: string;
  search?: string;
  after?: string;
};
export function validBoard(
  body: unknown,
  eventId: string,
  query: WorkloadQuery,
): boolean;
export function boardQueries(cursors: Record<string, string>): WorkloadQuery[];
