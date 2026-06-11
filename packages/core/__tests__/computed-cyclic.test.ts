import { describe, expect, it } from "vitest";

import { computed } from "../computed";
import { computedCyclic } from "../computed-cyclic";
import { effect } from "../reactivity";
import { signal } from "../signal";

describe("computedCyclic", () => {
	it("works as a normal computed", () => {
		const a = signal(1);
		const b = computed(() => a.value + 1);
		const c = computedCyclic(() => b.value + 1);

		expect(c.value).toBe(3);
		a.value = 2;
		expect(c.value).toBe(4);
	});

	it("returns undefined when it references itself", () => {
		const a = computedCyclic((): number => (a.value ?? 10) + 1);

		// evaluate a:
		// evaluate a -> a: undefined
		// a = 10 + 1
		expect(a.value).toBe(11);
	});

	it("returns its stabilizer when it references itself", () => {
		const a = computedCyclic(
			(): number => a.value + 1,
			() => 10,
		);

		// evaluate a:
		// evaluate a -> a: 10
		// a = 10 + 1
		expect(a.value).toBe(11);
	});

	it("can evaluate conditional references", { timeout: 1000 }, () => {
		const fieldA = signal(false);
		const fieldB = signal(false);

		const a = computedCyclic(() => {
			return b.value !== true ? fieldA.value : null;
		});

		const b = computedCyclic((): boolean | null => {
			return a.value !== true ? fieldB.value : null;
		});

		expect(a.value).toBe(false);
		expect(b.value).toBe(false);

		fieldA.value = true;

		expect(a.value).toBe(true);
		expect(b.value).toBe(null);

		fieldA.value = false;
		fieldB.value = true;

		expect(a.value).toBe(null);
		expect(b.value).toBe(true);
	});

	it("can produce different results for mutually dependent cyclic computeds", () => {
		const a = computedCyclic(
			(): number => {
				return b.value > 10 ? 1 : 2;
			},
			() => 0,
		);

		const b = computedCyclic(
			() => {
				return a.value > 1 ? 10 : 20;
			},
			() => 0,
		);

		// evaluate a:
		// evaluate b -> a: 0
		// b = 20
		// a = 1
		expect(a.value).toBe(1);

		// evaluate b:
		// evaluate a -> b: 0
		// a = 2
		// b = 10
		expect(b.value).toBe(10);
	});

	it("only caches values where it has calculated the correct value", () => {
		const a0 = signal(10);
		const a = computedCyclic(() => a0.value);
		const b = computedCyclic((): number => (a.value ?? 0) + (c.value ?? 0) + 5);
		const c = computedCyclic((): number => (b.value ?? 0) + 2);
		const d = computedCyclic(() => (c.value ?? 0) + 1);

		// a = 10
		// b:
		//   a: 10
		//   c:
		//     b: undefined
		//   c: 0 + 2 = 2
		// b: a + c + 5 = 10 + 2 + 5 = 17
		// c:
		//   b:
		//     a: 10
		//     c: undefined
		//   b: 10 + 0 + 5 = 15
		// c: 15 + 2 = 17

		expect(d.value).toBe(18);
		expect(c.value).toBe(17);
		expect(b.value).toBe(17);

		// check that changing it still works
		a0.value = 100;
		expect(d.value).toBe(108);
		expect(c.value).toBe(107);
		expect(b.value).toBe(107);
	});

	it("can get the value of a cyclic dependency through a normal computed", () => {
		const a0 = signal(10);
		const a = computedCyclic(
			() => a0.value,
			() => 10,
		);
		const b = computedCyclic(
			(): number => a.value + (c.value ?? 0) + 5,
			() => 0,
		);
		const c = computedCyclic(
			(): number => b.value + 2,
			() => 0,
		);
		const d = computed(() => c.value + 1);

		expect(d.value).toBe(18);
		a0.value = 100;
		expect(d.value).toBe(108);
	});

	describe("caching", () => {
		it("caches computed values and resets flags", () => {
			const a0 = signal(10);
			const a = computedCyclic(
				() => a0.value,
				() => 10,
			);
			const b = computedCyclic(
				(): number => a.value + (c.value ?? 0) + 5,
				() => 0,
			);
			const c = computedCyclic(
				(): number => b.value + 2,
				() => 0,
			);
			const d = computed(() => c.value + 1);

			expect(d.value).toBe(18);

			expect(d.currentValue).toBe(18);
			expect(c.currentValue).toBe(17);

			a0.value = 100;
			expect(d.value).toBe(108);
			expect(d.currentValue).toBe(108);
			expect(c.currentValue).toBe(107);
		});
	});

	describe("effect", () => {
		// TODO: fix these tests somehow, I might be using effect wrong
		it.skip("when a computedCyclic changes it should trigger an effect", () => {
			const a = signal(10);
			const b = computedCyclic(
				(): number => a.value + c.value + 2,
				() => 0,
			);
			const c = computedCyclic(
				() => a.value + b.value + 1,
				() => 0,
			);

			let triggers = 0;

			effect(() => {
				c.value;
				triggers++;
			});

			expect(triggers).toBe(1);

			a.value = 1;

			expect(triggers).toBe(2);
		});

		it.skip("should not trigger an effect if the computed value did not change", () => {
			const a = signal(10);
			const b = computedCyclic(
				(): number => a.value + Number(isLessThan10.value) + 2,
				() => 0,
			);
			const isLessThan10 = computedCyclic(
				() => a.value + b.value < 10,
				() => false,
			);

			let triggers = 0;

			effect(() => {
				isLessThan10.value;
				triggers++;
			});

			expect(triggers).toBe(1);
			a.value = 1;
			expect(triggers).toBe(2);
			expect(isLessThan10.value).toBe(false);
			a.value = 1;
			expect(triggers).toBe(2);

			a.value = 2;
			// a(2) would still cause the result to be less than 10, thus no trigger
			expect(triggers).toBe(2);

			a.value = 100;
			expect(triggers).toBe(3);
		});
	});
});
