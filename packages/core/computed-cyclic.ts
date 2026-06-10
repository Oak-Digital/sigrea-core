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
	shouldUpdate,
	unlink,
	untracked,
} from "./reactivity";

type ComputedCyclicSource<T> = () => T;
type ComputedCyclicStabilizer<S = undefined> = () => S;

const COMPUTED_CYCLIC_BRAND = Symbol("sigrea.isComputedCyclic");

type Context = {
	stack: ComputedCyclic[];
	stackNodes: Set<ComputedCyclic>;
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

			return this.stabilizer();
		}
		if (!shouldUpdate(this)) {
			const subscriber = getActiveSubscriber();
			if (subscriber !== undefined) {
				link(this, subscriber, getCurrentCycle());
			}
			// biome-ignore lint/style/noNonNullAssertion: Since we should not update we know the value must have been set
			const value = this.currentValue!;
			return value;
		}

		// At this point we know that something in the graph is dirty
		activeContext ??= {
			sccHead: undefined,
			sccTail: undefined,
			stack: [],
			stackNodes: new Set(),
		};
		const context = activeContext;
		context.stack.push(this);
		context.stackNodes.add(this);
		// console.log("context", context);
		// Run getter and only update if not part of the scc
		try {
			// REFACTOR: this currently causes the call to be recursive
			const result = this.getter();
			// Calling the getter will now have updated the context so we know if we are in a scc
			const isInScc = this.isInScc();
			if (isInScc) {
				return result;
			}
			const changed = hasChanged(this.currentValue, result);
			if (changed) {
				this.currentValue = result;
				const subs = this.subs;
				if (subs !== undefined) {
					shallowPropagate(subs);
				}
			}
			return result;
		} finally {
			context.stack.pop();
			context.stackNodes.delete(this);
			const currentStackIndex = context.stack.length - 1;
			if (currentStackIndex === context.sccHead) {
				context.sccHead = undefined;
				context.sccTail = undefined;
			} else if (context.sccTail !== undefined) {
				context.sccTail--;
			}
		}

		// if (this.update()) {
		// 	const subs = this.subs;
		// 	if (subs !== undefined) {
		// 		shallowPropagate(subs);
		// 	}
		// }
		// const subscriber = getActiveSubscriber();
		// if (subscriber !== undefined) {
		// 	link(this, subscriber, getCurrentCycle());
		// }
		// const value = this.currentValue;
		// return value!;
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
		incrementCycle();
		this.depsTail = undefined;
		this.flags = ReactiveFlags.Mutable | ReactiveFlags.RecursedCheck;
		const previous = getActiveSubscriber();
		setActiveSubscriber(this);
		const prevContext = setNewActiveContext();
		// biome-ignore lint/style/noNonNullAssertion: Non-null assertion because we just updated it in the line above
		const constex = activeContext!;
		constex.stack.push(this);
		constex.stackNodes.add(this);
		try {
			const nextValue = this.getter();
			const changed = hasChanged(this.currentValue, nextValue);
			this.currentValue = nextValue;
			return changed;
		} finally {
			setActiveSubscriber(previous);
			setActiveContext(prevContext);
			this.flags &= ~ReactiveFlags.RecursedCheck;
			let toRemove =
				this.depsTail !== undefined
					? (this.depsTail as Link).nextDep
					: this.deps;
			while (toRemove !== undefined) {
				toRemove = unlink(toRemove, this);
			}
		}
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
