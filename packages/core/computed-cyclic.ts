import {
	type Link,
	ReactiveFlags,
	type ReactiveNode,
	SignalFlags,
	getActiveSubscriber,
	getCurrentCycle,
	hasChanged,
	incrementCycle,
	link,
	setActiveSubscriber,
	shallowPropagate,
	unlink,
	untracked,
} from "./reactivity";

type ComputedCyclicSource<T> = () => T;
type ComputedCyclicStabilizer<S = undefined> = () => S;

const COMPUTED_CYCLIC_BRAND = Symbol("sigrea.isComputedCyclic");

type Context = {
	stack: ComputedCyclic[];
	stackNodes: Set<ComputedCyclic>;
	provisionalNodes: Set<ComputedCyclic>;
	/** From where the current scc starts, by default there are no scc */
	sccHead: number | undefined;
	/** To where the current scc ends */
	sccTail: number | undefined;
};

let activeContext: Context | undefined;

export function getActiveContext() {
	return activeContext;
}

export function setActiveContext(context: Context | undefined) {
	const prevContext = getActiveContext();
	activeContext = context;
	return prevContext;
}

export function setNewActiveContext() {
	const prevContext = getActiveContext();
	activeContext = {
		stack: [],
		stackNodes: new Set(),
		provisionalNodes: new Set(),
		sccHead: undefined,
		sccTail: undefined,
	};
	return prevContext;
}

export class ComputedCyclic<T = unknown, S = unknown> implements ReactiveNode {
	readonly [SignalFlags.IS_SIGNAL] = true;
	readonly [COMPUTED_CYCLIC_BRAND] = true;
	currentValue: T | undefined = undefined;
	subs: Link | undefined = undefined;
	subsTail: Link | undefined = undefined;
	deps: Link | undefined = undefined;
	depsTail: Link | undefined = undefined;
	flags: ReactiveFlags = ReactiveFlags.Mutable | ReactiveFlags.Dirty;
	// private readonly setter?: (value: T) => void;
	public getter: () => T;
	private stabilizer: ComputedCyclicStabilizer<S>;

	constructor(
		source: ComputedCyclicSource<T>,
		stabilizer: ComputedCyclicStabilizer<S>,
	) {
		this.getter = source;
		this.stabilizer = stabilizer;
	}

	private isCyclic(): boolean {
		const context = activeContext;
		const hasCurrent = context?.stackNodes.has(this);
		return !!hasCurrent;
	}

	private isInScc(): boolean {
		const context = getActiveContext();
		if (!context) {
			return false;
		}

		const currentStackIndex = context.stack.length - 1;

		if (context.sccTail === undefined || context.sccHead === undefined) {
			return false;
		}

		if (currentStackIndex > context.sccTail) {
			return false;
		}

		if (currentStackIndex <= context.sccHead) {
			return false;
		}

		return true;
	}

	private evaluate(): {
		result: T;
		changed: boolean;
		isProvisional: boolean;
	} {
		const hadValue = this.currentValue !== undefined;
		incrementCycle();
		this.depsTail = undefined;
		const previousFlags = this.flags;
		this.flags = ReactiveFlags.Mutable | ReactiveFlags.RecursedCheck;
		const previousSubscriber = getActiveSubscriber();
		setActiveSubscriber(this);
		const previousContext = activeContext;
		activeContext ??= {
			sccHead: undefined,
			sccTail: undefined,
			stack: [],
			stackNodes: new Set(),
			provisionalNodes: new Set(),
		};
		const context = activeContext;
		context.stack.push(this);
		context.stackNodes.add(this);
		let result!: T;
		let changed = false;
		let isInScc = false;
		let isProvisional = false;
		try {
			result = this.getter();
			isInScc = this.isInScc();
			isProvisional = context.provisionalNodes.has(this);
			if (!isInScc) {
				changed = hasChanged(this.currentValue, result);
				this.currentValue = result;
				if (previousSubscriber === undefined && !hadValue) {
					let dep = this.deps;
					while (dep !== undefined) {
						const candidate = dep.dep as Partial<ComputedCyclic>;
						if (
							candidate[COMPUTED_CYCLIC_BRAND] === true &&
							candidate.currentValue === undefined &&
							candidate.flags === (ReactiveFlags.Mutable | ReactiveFlags.Dirty)
						) {
							(candidate as ComputedCyclic).evaluate();
						}
						dep = dep.nextDep;
					}
				}
			}
			return {
				result,
				changed,
				isProvisional,
			};
		} finally {
			setActiveSubscriber(previousSubscriber);
			if (isInScc) {
				this.flags = previousFlags;
			} else if (isProvisional) {
				let shouldPromote = previousSubscriber === undefined && !hadValue;
				if (shouldPromote) {
					shouldPromote = false;
					let dep = this.deps;
					while (dep !== undefined) {
						const candidate = dep.dep as Partial<ComputedCyclic>;
						if (candidate.currentValue !== undefined) {
							shouldPromote = true;
							break;
						}
						dep = dep.nextDep;
					}
				}
				this.flags = shouldPromote
					? ReactiveFlags.Mutable
					: ReactiveFlags.Mutable | ReactiveFlags.Dirty;
				if (shouldPromote) {
					let dep = this.deps;
					while (dep !== undefined) {
						const candidate = dep.dep as Partial<ComputedCyclic>;
						if (
							candidate.currentValue !== undefined &&
							candidate.flags === (ReactiveFlags.Mutable | ReactiveFlags.Dirty)
						) {
							candidate.flags = ReactiveFlags.Mutable;
						}
						dep = dep.nextDep;
					}
				}
			} else {
				this.flags &= ~ReactiveFlags.RecursedCheck;
			}
			if (!isInScc) {
				let toRemove =
					this.depsTail !== undefined
						? (this.depsTail as Link).nextDep
						: this.deps;
				while (toRemove !== undefined) {
					toRemove = unlink(toRemove, this);
				}
			}
			context.stack.pop();
			context.stackNodes.delete(this);
			context.provisionalNodes.delete(this);
			const currentStackIndex = context.stack.length - 1;
			if (currentStackIndex === context.sccHead) {
				context.sccHead = undefined;
				context.sccTail = undefined;
			} else if (context.sccTail !== undefined) {
				context.sccTail--;
			}
			if (previousContext === undefined && context.stack.length === 0) {
				activeContext = undefined;
			}
		}
	}

	get(): T | S {
		if (this.isCyclic()) {
			// biome-ignore lint/style/noNonNullAssertion: if we are not in a context we cannot be in a cycle
			const context = activeContext!;

			context.sccTail = context.stack.length - 1;
			const prevOccuranceIndex = context.stack.indexOf(this);
			// Since it is cyclic we assume that this must be on the stack
			context.sccHead = Math.min(
				context.sccHead ?? Number.POSITIVE_INFINITY,
				prevOccuranceIndex,
			);
			for (let index = prevOccuranceIndex; index < context.stack.length; index++) {
				context.provisionalNodes.add(context.stack[index] as ComputedCyclic);
			}

			return this.stabilizer();
		}
		let value: T | S;
		if (this.flags & (ReactiveFlags.Dirty | ReactiveFlags.Pending)) {
			const subscriber = getActiveSubscriber();
			const { result, changed, isProvisional } = this.evaluate();
			if (isProvisional && subscriber !== undefined) {
				subscriber.flags |= ReactiveFlags.Dirty;
			}
			if (changed && !isProvisional) {
				const subs = this.subs;
				if (subs !== undefined) {
					shallowPropagate(subs);
				}
			}
			value = result;
		} else {
			// biome-ignore lint/style/noNonNullAssertion: Since we should not update we know the value must have been set
			value = this.currentValue!;
		}
		const subscriber = getActiveSubscriber();
		if (subscriber !== undefined) {
			link(this, subscriber, getCurrentCycle());
		}
		return value;
	}

	get value(): T | S {
		return this.get();
	}

	// set value(next: T) {
	// 	if (this.setter === undefined) {
	// 		throw new TypeError("Cannot assign to a readonly computed value.");
	// 	}
	// 	this.setter(next);
	// }

	peek(): T | S {
		return untracked(this.getter);
	}

	update(): boolean {
		const { changed, isProvisional } = this.evaluate();
		return changed && !isProvisional;
	}
}

export function computedCyclic<T>(
	source: ComputedCyclicSource<T>,
): ComputedCyclic<T, undefined>;
export function computedCyclic<T, S>(
	source: ComputedCyclicSource<T>,
	stabilizer: ComputedCyclicStabilizer<S>,
): ComputedCyclic<T, S>;
export function computedCyclic<T, S>(
	source: ComputedCyclicSource<T>,
	stabilizer?: ComputedCyclicStabilizer<S>,
) {
	return new ComputedCyclic(source, stabilizer ?? (() => undefined));
}

export function isComputedCyclic<T>(
	value: unknown,
): value is ComputedCyclic<T> {
	return Boolean(
		value &&
			(typeof value === "object" || typeof value === "function") &&
			(value as Record<PropertyKey, unknown>)[COMPUTED_CYCLIC_BRAND] === true,
	);
}
