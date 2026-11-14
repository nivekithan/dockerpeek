import { tracing } from "cloudflare:workers";
import { Context, Exit, Layer, Logger, Option, Tracer } from "effect";

/** Sends Effect spans and structured logs through Workers' native observability pipeline. */
export const Observability = Layer.mergeAll(
  Layer.succeed(
    Tracer.Tracer,
    Tracer.make({
      span(options) {
        const parent = Option.getOrUndefined(options.parent);
        const create = () => new WorkersSpan(options, tracing.startSpan(options.name));
        return parent instanceof WorkersSpan
          ? tracing.withActiveSpan(parent.native, create)
          : create();
      },
      context(primitive, fiber) {
        const parent = Context.getOption(fiber.context, Tracer.ParentSpan);
        const evaluate = () => primitive["~effect/Effect/evaluate"](fiber);
        return Option.isSome(parent) && parent.value instanceof WorkersSpan
          ? tracing.withActiveSpan(parent.value.native, evaluate)
          : evaluate();
      },
    }),
  ),
  Logger.layer([Logger.consoleStructured]),
);

/** Native context makes platform I/O and console logs children of the current Effect span. */
class WorkersSpan extends Tracer.NativeSpan {
  constructor(
    options: ConstructorParameters<typeof Tracer.NativeSpan>[0],
    readonly native: Span,
  ) {
    super(options);
  }

  override get traceId() {
    return this.native.spanContext().traceId;
  }

  override get spanId() {
    return this.native.spanContext().spanId;
  }

  override attribute(key: string, value: unknown) {
    if (this.status._tag === "Ended") return;
    super.attribute(key, value);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      this.native.setAttribute(key, value);
  }

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>) {
    if (this.status._tag === "Ended") return;
    super.end(endTime, exit);
    // Do not copy failure payloads: registry errors can contain signed URLs or response bodies.
    this.native.setStatus({ code: Exit.isSuccess(exit) ? "ok" : "error" });
    this.native.end();
  }
}
