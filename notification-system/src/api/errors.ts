import { IdempotencyKeyReuseError, NoDestinationError } from "../notifications/service.js";
import { TemplateNotFoundError, TemplateParamError } from "../notifications/templates.js";
import { DuplicateContactError, UserNotFoundError } from "../users/repository.js";

export class ResourceNotFoundError extends Error {}

// The one place that says which HTTP status each domain error becomes, so the routes do not catch.
const STATUS_BY_ERROR: [new (...args: never[]) => Error, number][] = [
  [UserNotFoundError, 404],
  [ResourceNotFoundError, 404],
  [DuplicateContactError, 409],
  [IdempotencyKeyReuseError, 422],
  [TemplateNotFoundError, 422],
  [TemplateParamError, 422],
  [NoDestinationError, 422],
];

export function httpStatusOf(err: unknown): number | undefined {
  return STATUS_BY_ERROR.find(([type]) => err instanceof type)?.[1];
}
