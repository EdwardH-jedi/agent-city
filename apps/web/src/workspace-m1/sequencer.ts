// Request tickets (role 07): every read/challenge/artifact request is bound to the auth generation
// and to a slot that names its subject (e.g. `detail:<task id>`). A response is applied only if
// its ticket is still the latest of its slot AND of the current auth generation — so A→B
// navigation, a closed viewer, sign-out / sign-in and late 401s can never apply stale data.
export interface Ticket {
	readonly authGen: number;
	readonly slot: string;
	readonly seq: number;
}

export class Sequencer {
	private gen = 0;
	private readonly latest = new Map<string, number>();
	private counter = 0;

	get authGen(): number {
		return this.gen;
	}

	/** A new request in `slot`; every older in-flight request of the slot becomes stale. */
	begin(slot: string): Ticket {
		this.counter += 1;
		this.latest.set(slot, this.counter);
		return { authGen: this.gen, slot, seq: this.counter };
	}

	isCurrent(t: Ticket): boolean {
		return t.authGen === this.gen && this.latest.get(t.slot) === t.seq;
	}

	/** Only the auth generation matters (decision outcomes stay attributed to their request). */
	isSameAuth(t: { authGen: number }): boolean {
		return t.authGen === this.gen;
	}

	/** Drop whatever is in flight for the slot (viewer closed, subject left). */
	invalidate(slot: string): void {
		this.counter += 1;
		this.latest.set(slot, this.counter);
	}

	/** Sign-in / sign-out / session loss: every in-flight request of the old generation is stale. */
	bumpAuth(): number {
		this.gen += 1;
		this.latest.clear();
		return this.gen;
	}
}
