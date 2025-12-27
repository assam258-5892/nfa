// ============== NFA Runtime (RPR_NFA_CONCEPT.md) ==============
// Requires: parser.js

/**
 * MatchState: NFA runtime state
 * - elementIndex: current pattern position (-1 = completed)
 * - counts[]: repetition counts per depth level
 * - matchedPaths[]: paths for CLASSIFIER() support
 */
class MatchState {
    constructor(elementIndex, counts = [], matchedPaths = [[]]) {
        this.elementIndex = elementIndex;
        this.counts = [...counts];
        this.matchedPaths = matchedPaths.map(p => [...p]);
    }

    clone() {
        return new MatchState(
            this.elementIndex,
            [...this.counts],
            this.matchedPaths.map(p => [...p])
        );
    }

    withMatch(varName) {
        const s = this.clone();
        s.matchedPaths = s.matchedPaths.map(p => [...p, varName]);
        return s;
    }

    mergePaths(other) {
        const existing = new Set(this.matchedPaths.map(p => p.join(',')));
        for (const path of other.matchedPaths) {
            const key = path.join(',');
            if (!existing.has(key)) {
                this.matchedPaths.push([...path]);
                existing.add(key);
            }
        }
    }

    hash() {
        return `${this.elementIndex}:${this.counts.join(',')}`;
    }
}

/**
 * MatchContext: Group of states with same matchStart
 */
let _ctxId = 0;

class MatchContext {
    constructor(matchStart) {
        this.id = _ctxId++;
        this.matchStart = matchStart;
        this.matchEnd = -1;
        this.isCompleted = false;
        this.states = [];
        this.completedPaths = [];
        this._pathSet = new Set();
    }

    addCompletedPath(path) {
        if (!path || path.length === 0) return;
        const key = path.join(',');
        if (!this._pathSet.has(key)) {
            this._pathSet.add(key);
            this.completedPaths.push([this.id, ...path]);
        }
    }
}

/**
 * NFAExecutor: Main execution engine
 */
class NFAExecutor {
    constructor(pattern) {
        this.pattern = pattern;
        this.contexts = [];
        this.currentRow = -1;
        this.history = [];
        _ctxId = 0;
    }

    reset() {
        this.contexts = [];
        this.currentRow = -1;
        this.history = [];
        _ctxId = 0;
    }

    /**
     * Process one row of input
     */
    processRow(trueVars) {
        this.currentRow++;
        const row = this.currentRow;
        const logs = [];
        const log = (msg, type = 'info') => logs.push({ message: msg, type });
        const stateMerges = [];

        log(`Processing row ${row}: [${trueVars.join(', ') || 'none'}]`);

        // 1. Try to start new context
        this.tryStartNewContext(row, trueVars, log, stateMerges);

        // 2. Process existing contexts
        const discardedStates = [];
        const deadStates = [];
        for (const ctx of this.contexts) {
            if (ctx.isCompleted || ctx.matchStart === row) continue;
            const result = this.processContext(ctx, row, trueVars, log, stateMerges);
            if (result) {
                if (result.discardedStates) discardedStates.push(...result.discardedStates);
                if (result.deadStates) deadStates.push(...result.deadStates);
            }
        }

        // 3. Context absorption
        const absorptions = this.absorbContexts(log);

        // 4. Snapshot for history
        // Include contexts that have states, are completed, or have dead states in this row
        const deadContextIds = new Set(deadStates.map(ds => ds.contextId));
        const contextSnapshot = this.contexts
            .filter(ctx => ctx.states.length > 0 || ctx.isCompleted || deadContextIds.has(ctx.id))
            .map(ctx => ({
                id: ctx.id,
                matchStart: ctx.matchStart,
                matchEnd: ctx.matchEnd,
                isCompleted: ctx.isCompleted,
                isDead: ctx.states.length === 0 && !ctx.isCompleted,
                completedPaths: [...ctx.completedPaths],
                states: ctx.states.map(s => ({
                    elementIndex: s.elementIndex,
                    counts: [...s.counts],
                    matchedPaths: s.matchedPaths.map(p => [...p])
                }))
            }));

        this.history.push({ row, input: [...trueVars], contexts: contextSnapshot, absorptions, stateMerges, discardedStates, deadStates, logs });

        // 5. Remove dead/completed contexts
        this.contexts = this.contexts.filter(ctx => ctx.states.length > 0 && !ctx.isCompleted);

        return { row, contexts: contextSnapshot, absorptions, stateMerges, discardedStates, deadStates, logs };
    }

    /**
     * Try to start a new context
     */
    tryStartNewContext(row, trueVars, log, stateMerges) {
        if (this.pattern.elements.length === 0) return;

        // Initial state at element 0
        const initCounts = new Array(this.pattern.maxDepth + 1).fill(0);
        const initState = new MatchState(0, initCounts);

        // Expand to wait positions (VAR or #ALT)
        const waitStates = this.expandToWaitPositions([initState]);

        // Find states that can consume input
        const consumableStates = [];
        for (const state of waitStates) {
            if (state.elementIndex === -1) continue;
            const elem = this.pattern.elements[state.elementIndex];
            if (!elem) continue;

            if (elem.isVar() && trueVars.includes(elem.varName)) {
                consumableStates.push(state);
            } else if (elem.isAltStart()) {
                // Check each alternative
                let altIdx = elem.next;
                while (altIdx >= 0 && altIdx < this.pattern.elements.length) {
                    const altElem = this.pattern.elements[altIdx];
                    if (altElem && altElem.isVar() && trueVars.includes(altElem.varName)) {
                        const altState = state.clone();
                        altState.elementIndex = altIdx;
                        consumableStates.push(altState);
                    }
                    altIdx = altElem ? altElem.jump : -1;
                }
            }
        }

        if (consumableStates.length === 0) return;

        // Create new context
        const ctx = new MatchContext(row);

        // Consume input and generate next states
        const { activeStates, completedStates } = this.consumeInput(consumableStates, trueVars, log, stateMerges, ctx.id);

        // Expand active states to wait positions for next row
        let nextWaitStates = this.expandToWaitPositions(Array.from(activeStates.values()));

        // Filter out non-viable states (when no pattern variable matches)
        const patternVars = this.pattern.variables;
        const hasPatternMatch = trueVars.some(v => patternVars.includes(v));
        if (!hasPatternMatch) {
            nextWaitStates = this.filterNonViableStates(nextWaitStates, trueVars);
        }

        // Separate completed from active
        for (const state of nextWaitStates) {
            if (state.elementIndex === -1) {
                const hash = state.hash();
                if (completedStates.has(hash)) {
                    completedStates.get(hash).mergePaths(state);
                } else {
                    completedStates.set(hash, state);
                }
            } else {
                ctx.states.push(state);
            }
        }

        // Merge duplicate active states
        ctx.states = this.mergeStates(ctx.states, stateMerges, ctx.id);

        // Extract completed paths
        for (const state of completedStates.values()) {
            for (const path of state.matchedPaths) {
                ctx.addCompletedPath(path);
            }
        }

        // Set matchEnd based on actual path lengths (exclude ID prefix)
        if (ctx.completedPaths.length > 0) {
            const maxLen = Math.max(...ctx.completedPaths.map(p => p.length - 1));
            ctx.matchEnd = ctx.matchStart + maxLen - 1;
            if (ctx.states.length === 0) {
                ctx.isCompleted = true;
                log(`MATCH COMPLETE! rows ${ctx.matchStart}-${ctx.matchEnd}`, 'success');
            } else {
                log(`Potential match at rows ${ctx.matchStart}-${ctx.matchEnd}, continuing...`, 'warning');
            }
        }

        if (ctx.states.length > 0 || ctx.isCompleted) {
            this.contexts.push(ctx);
            log(`New context #${ctx.id} started at row ${row}`, 'success');
        }
    }

    /**
     * Process existing context
     * Returns { discardedStates, deadStates } for shorter match discards and mismatch deaths
     */
    processContext(ctx, row, trueVars, log, stateMerges) {
        // Consume input from current wait states
        const { activeStates, completedStates, deadStates } = this.consumeInput(ctx.states, trueVars, log, stateMerges, ctx.id);

        // Expand to next wait positions
        let nextWaitStates = this.expandToWaitPositions(Array.from(activeStates.values()));

        // Filter out non-viable states (when no pattern variable matches)
        const patternVars = this.pattern.variables;
        const hasPatternMatch = trueVars.some(v => patternVars.includes(v));
        if (!hasPatternMatch) {
            nextWaitStates = this.filterNonViableStates(nextWaitStates, trueVars);
        }

        // Separate completed from active
        ctx.states = [];
        for (const state of nextWaitStates) {
            if (state.elementIndex === -1) {
                const hash = state.hash();
                if (completedStates.has(hash)) {
                    completedStates.get(hash).mergePaths(state);
                } else {
                    completedStates.set(hash, state);
                }
            } else {
                ctx.states.push(state);
            }
        }

        // Merge duplicates
        ctx.states = this.mergeStates(ctx.states, stateMerges, ctx.id);

        // Discard shorter matches if longer matches are possible
        // But only if active states can actually progress with current input
        const discardedStates = [];
        const canProgressFurther = ctx.states.some(s => {
            const elem = this.pattern.elements[s.elementIndex];
            if (!elem) return false;
            // Check if this state can actually consume current input
            if (elem.isVar()) {
                return trueVars.includes(elem.varName);
            } else if (elem.isAltStart()) {
                // Check if any alternative can match
                let altIdx = elem.next;
                while (altIdx >= 0 && altIdx < this.pattern.elements.length) {
                    const altElem = this.pattern.elements[altIdx];
                    if (altElem && altElem.isVar() && trueVars.includes(altElem.varName)) {
                        return true;
                    }
                    altIdx = altElem ? altElem.jump : -1;
                }
            }
            return false;
        });

        if (completedStates.size > 0 && ctx.states.length > 0 && canProgressFurther && hasPatternMatch) {
            // Active states exist and input has pattern variables - can potentially match longer
            // Greedy: preserve best completion for fallback, discard others

            // Collect all completed paths with their info
            const allCompletedPaths = [];
            for (const state of completedStates.values()) {
                for (const path of state.matchedPaths) {
                    allCompletedPaths.push(path);
                }
            }

            // Select best path: longest first, then lexical order
            if (allCompletedPaths.length > 0) {
                allCompletedPaths.sort((a, b) => {
                    // Longer path wins
                    if (b.length !== a.length) return b.length - a.length;
                    // Same length: lexical order (earlier = better)
                    return a.join(' ').localeCompare(b.join(' '));
                });

                const bestPath = allCompletedPaths[0];
                ctx.addCompletedPath(bestPath);
                log(`Greedy: preserving best completion for fallback: ${bestPath.join(' ')}`, 'warning');

                // Mark others as discarded
                for (let i = 1; i < allCompletedPaths.length; i++) {
                    discardedStates.push({
                        contextId: ctx.id,
                        elementIndex: -1, // #FIN
                        counts: [],
                        matchedPaths: [allCompletedPaths[i]],
                        reason: 'shorter_match'
                    });
                }
                if (allCompletedPaths.length > 1) {
                    log(`Discarding ${allCompletedPaths.length - 1} shorter match(es)`, 'warning');
                }
            }
        } else {
            // No active states, or can't progress further, or no pattern match - keep all completed paths
            for (const state of completedStates.values()) {
                for (const path of state.matchedPaths) {
                    ctx.addCompletedPath(path);
                }
            }
        }

        // Update matchEnd based on actual path lengths (exclude ID prefix)
        if (ctx.completedPaths.length > 0) {
            const maxLen = Math.max(...ctx.completedPaths.map(p => p.length - 1));
            ctx.matchEnd = ctx.matchStart + maxLen - 1;
        }

        // Check completion
        if (ctx.states.length === 0) {
            if (ctx.completedPaths.length > 0 || ctx.matchEnd >= 0) {
                ctx.isCompleted = true;
                log(`MATCH COMPLETE! rows ${ctx.matchStart}-${ctx.matchEnd}`, 'success');
            } else {
                log(`Context #${ctx.id} died - no valid states`, 'error');
            }
        } else if (ctx.completedPaths.length > 0) {
            log(`Potential match at rows ${ctx.matchStart}-${ctx.matchEnd}, continuing...`, 'warning');
        }

        return { discardedStates, deadStates };
    }

    /**
     * Consume input from states and produce next states
     * Returns { activeStates: Map, completedStates: Map, deadStates: Array }
     */
    consumeInput(states, trueVars, log, stateMerges, ctxId) {
        const activeStates = new Map();
        const completedStates = new Map();
        const deadStates = [];

        for (const state of states) {
            const results = this.transition(state, trueVars, log);
            if (results.length === 0) {
                // State died - mismatch
                deadStates.push({
                    contextId: ctxId,
                    elementIndex: state.elementIndex,
                    counts: [...state.counts],
                    matchedPaths: state.matchedPaths.map(p => [...p]),
                    reason: 'mismatch'
                });
            }
            for (const newState of results) {
                const hash = newState.hash();
                if (newState.elementIndex === -1) {
                    if (completedStates.has(hash)) {
                        completedStates.get(hash).mergePaths(newState);
                    } else {
                        completedStates.set(hash, newState);
                    }
                } else {
                    if (activeStates.has(hash)) {
                        activeStates.get(hash).mergePaths(newState);
                    } else {
                        activeStates.set(hash, newState);
                    }
                }
            }
        }

        return { activeStates, completedStates, deadStates };
    }

    /**
     * Core transition function: consume input at current position
     */
    transition(state, trueVars, log) {
        const results = [];
        if (state.elementIndex === -1) return results;

        const elem = this.pattern.elements[state.elementIndex];
        if (!elem) {
            results.push(new MatchState(-1, state.counts, state.matchedPaths));
            return results;
        }

        if (elem.isVar()) {
            this.transitionVar(state, elem, trueVars, log, results);
        } else if (elem.isAltStart()) {
            this.transitionAlt(state, elem, trueVars, log, results);
        } else if (elem.isGroupEnd()) {
            // #END should be processed in expandToWaitPositions, not here
            // But if we're at #END, it means we need to process it
            this.transitionGroupEnd(state, elem, log, results);
        } else if (elem.isFinish()) {
            results.push(new MatchState(-1, state.counts, state.matchedPaths));
        }

        return results;
    }

    /**
     * VAR transition
     */
    transitionVar(state, elem, trueVars, log, results) {
        const matches = trueVars.includes(elem.varName);
        const count = state.counts[elem.depth] || 0;

        if (matches) {
            const newCount = count + 1;
            const newState = state.withMatch(elem.varName);
            newState.counts[elem.depth] = newCount;

            if (newCount < elem.max) {
                // Stay at VAR (can match more)
                results.push(newState);
                log(`${elem.varName} matched (${newCount}), staying`);
            } else {
                // Max reached - advance
                newState.counts[elem.depth] = 0;
                newState.elementIndex = elem.next;
                results.push(newState);
                log(`${elem.varName} matched (max=${elem.max}), advancing`);
            }
        } else {
            // No match
            if (count >= elem.min) {
                // Min satisfied - advance without consuming
                const newState = state.clone();
                newState.counts[elem.depth] = 0;
                newState.elementIndex = elem.next;
                // Recursively transition to handle chained skips
                const subResults = this.transition(newState, trueVars, log);
                if (subResults.length > 0) {
                    results.push(...subResults);
                }
                // If subResults is empty, the chain couldn't progress - don't add wait state
                log(`${elem.varName} not matched, min satisfied, advancing`);
            } else {
                log(`${elem.varName} not matched, count=${count}<min=${elem.min}, DEAD`);
            }
        }
    }

    /**
     * #ALT transition - try each alternative in Lexical Order
     */
    transitionAlt(state, elem, trueVars, log, results) {
        let anyMatched = false;

        // Try each alternative
        let altIdx = elem.next;
        while (altIdx >= 0 && altIdx < this.pattern.elements.length) {
            const altElem = this.pattern.elements[altIdx];
            const altState = state.clone();
            altState.elementIndex = altIdx;

            const subResults = this.transition(altState, trueVars, log);
            if (subResults.length > 0) {
                anyMatched = true;
                results.push(...subResults);
            }

            altIdx = altElem ? altElem.jump : -1;
        }

        // If nothing matched, try to exit group
        if (!anyMatched) {
            const endElem = this.findGroupEnd(elem);
            if (endElem) {
                const count = state.counts[endElem.depth] || 0;
                if (count >= endElem.min) {
                    const exitState = state.clone();
                    exitState.counts[endElem.depth] = 0;
                    exitState.elementIndex = endElem.next;
                    // Recursively transition to handle chained skips
                    const subResults = this.transition(exitState, trueVars, log);
                    if (subResults.length > 0) {
                        results.push(...subResults);
                    } else {
                        results.push(exitState);
                    }
                    log(`No alternative matched, min=${endElem.min} satisfied, exiting group`);
                }
            }
        }
    }

    /**
     * #END transition
     */
    transitionGroupEnd(state, elem, log, results) {
        const count = (state.counts[elem.depth] || 0) + 1;

        if (count < elem.min) {
            // Must repeat
            const repeatState = state.clone();
            repeatState.counts[elem.depth] = count;
            this.resetInnerCounts(repeatState, elem.depth);
            repeatState.elementIndex = elem.jump;
            results.push(repeatState);
            log(`Group end: count=${count}<min=${elem.min}, must repeat`);
        } else if (count < elem.max) {
            // Fork: repeat or exit
            const repeatState = state.clone();
            repeatState.counts[elem.depth] = count;
            this.resetInnerCounts(repeatState, elem.depth);
            repeatState.elementIndex = elem.jump;
            results.push(repeatState);

            const exitState = state.clone();
            exitState.counts[elem.depth] = 0;
            exitState.elementIndex = elem.next;
            results.push(exitState);
            log(`Group end: count=${count}, FORK`);
        } else {
            // Max reached - must exit
            const exitState = state.clone();
            exitState.counts[elem.depth] = 0;
            exitState.elementIndex = elem.next;
            results.push(exitState);
            log(`Group end: count=${count}=max, exiting`);
        }
    }

    /**
     * Expand states to wait positions (VAR or #ALT)
     * Processes epsilon transitions (#END, #FIN)
     */
    expandToWaitPositions(states) {
        const result = [];
        const seen = new Map();
        const queue = [...states];

        while (queue.length > 0) {
            const state = queue.shift();
            const hash = state.hash();

            if (seen.has(hash)) {
                seen.get(hash).mergePaths(state);
                continue;
            }
            seen.set(hash, state);

            if (state.elementIndex === -1) {
                result.push(state);
                continue;
            }

            const elem = this.pattern.elements[state.elementIndex];
            if (!elem) {
                const fin = state.clone();
                fin.elementIndex = -1;
                result.push(fin);
                continue;
            }

            if (elem.isFinish()) {
                // #FIN - completed
                const fin = state.clone();
                fin.elementIndex = -1;
                result.push(fin);
            } else if (elem.isVar()) {
                // Wait at VAR
                result.push(state);

                // Also explore skip path if min satisfied
                const count = state.counts[elem.depth] || 0;
                if (count >= elem.min) {
                    const skip = state.clone();
                    skip.counts[elem.depth] = 0;
                    skip.elementIndex = elem.next;
                    queue.push(skip);
                }
            } else if (elem.isAltStart()) {
                // Wait at #ALT
                result.push(state);

                // Also explore skip if group min satisfied
                const endElem = this.findGroupEnd(elem);
                if (endElem) {
                    const count = state.counts[endElem.depth] || 0;
                    if (count >= endElem.min) {
                        const skip = state.clone();
                        skip.counts[endElem.depth] = 0;
                        skip.elementIndex = endElem.next;
                        queue.push(skip);
                    }
                }
            } else if (elem.isGroupEnd()) {
                // Process #END (epsilon)
                const count = (state.counts[elem.depth] || 0) + 1;

                if (count < elem.min) {
                    const repeat = state.clone();
                    repeat.counts[elem.depth] = count;
                    this.resetInnerCounts(repeat, elem.depth);
                    repeat.elementIndex = elem.jump;
                    queue.push(repeat);
                } else if (count < elem.max) {
                    // Fork
                    const repeat = state.clone();
                    repeat.counts[elem.depth] = count;
                    this.resetInnerCounts(repeat, elem.depth);
                    repeat.elementIndex = elem.jump;
                    queue.push(repeat);

                    const exit = state.clone();
                    exit.counts[elem.depth] = 0;
                    exit.elementIndex = elem.next;
                    queue.push(exit);
                } else {
                    const exit = state.clone();
                    exit.counts[elem.depth] = 0;
                    exit.elementIndex = elem.next;
                    queue.push(exit);
                }
            }
        }

        return result;
    }

    /**
     * Merge duplicate states (same hash)
     */
    mergeStates(states, stateMerges, ctxId) {
        const merged = new Map();
        for (const state of states) {
            const hash = state.hash();
            if (merged.has(hash)) {
                merged.get(hash).mergePaths(state);
            } else {
                merged.set(hash, state);
            }
        }
        return Array.from(merged.values());
    }

    /**
     * Find #END for #ALT
     */
    findGroupEnd(altElem) {
        let idx = altElem.next;
        while (idx >= 0 && idx < this.pattern.elements.length) {
            const elem = this.pattern.elements[idx];
            if (elem.isGroupEnd()) return elem;
            idx = elem.next;
        }
        return null;
    }

    /**
     * Reset inner counts
     */
    resetInnerCounts(state, depth) {
        for (let d = depth + 1; d < state.counts.length; d++) {
            state.counts[d] = 0;
        }
    }

    /**
     * Filter out non-viable states
     * States at #ALT or VAR that can't progress AND can't exit
     */
    filterNonViableStates(states, trueVars) {
        return states.filter(state => {
            if (state.elementIndex === -1) return true;

            const elem = this.pattern.elements[state.elementIndex];
            if (!elem) return true;

            if (elem.isAltStart()) {
                // Can any alternative match?
                const canMatch = this.canAltMatch(elem, trueVars);
                if (canMatch) return true;

                // Can we exit the group?
                const endElem = this.findGroupEnd(elem);
                if (endElem) {
                    const count = state.counts[endElem.depth] || 0;
                    return count >= endElem.min;
                }
                return false;
            } else if (elem.isVar()) {
                // Can we match this VAR?
                if (trueVars.includes(elem.varName)) return true;

                // Can we skip this VAR?
                const count = state.counts[elem.depth] || 0;
                return count >= elem.min;
            }

            return true;
        });
    }

    /**
     * Check if any alternative in a group can match the input
     */
    canAltMatch(altElem, trueVars) {
        let altIdx = altElem.next;
        while (altIdx >= 0 && altIdx < this.pattern.elements.length) {
            const elem = this.pattern.elements[altIdx];
            if (elem && elem.isVar() && trueVars.includes(elem.varName)) {
                return true;
            }
            altIdx = elem ? elem.jump : -1;
        }
        return false;
    }

    /**
     * Context absorption
     */
    absorbContexts(log) {
        const absorptions = [];
        if (this.contexts.length <= 1) return absorptions;

        this.contexts.sort((a, b) => a.matchStart - b.matchStart);
        const absorbed = new Set();

        for (let i = 0; i < this.contexts.length; i++) {
            if (absorbed.has(i)) continue;
            const earlier = this.contexts[i];
            if (earlier.isCompleted) continue;

            for (let j = i + 1; j < this.contexts.length; j++) {
                if (absorbed.has(j)) continue;
                const later = this.contexts[j];
                if (later.isCompleted) continue;

                const canAbsorb = later.states.every(ls =>
                    earlier.states.some(es => {
                        if (es.elementIndex !== ls.elementIndex) return false;
                        const elem = this.pattern.elements[es.elementIndex];
                        if (!elem) return true;
                        if (elem.max === Infinity) {
                            return es.counts.every((c, d) => (c || 0) >= (ls.counts[d] || 0));
                        }
                        return es.counts.every((c, d) => (c || 0) === (ls.counts[d] || 0));
                    })
                );

                if (canAbsorb && later.states.length > 0) {
                    absorbed.add(j);
                    absorptions.push({
                        absorbedId: later.id,
                        byId: earlier.id,
                        states: later.states.map(s => ({
                            elementIndex: s.elementIndex,
                            counts: [...s.counts],
                            matchedPaths: s.matchedPaths.map(p => [...p])
                        }))
                    });
                    log(`Context #${later.id} absorbed by #${earlier.id}`, 'warning');
                }
            }
        }

        this.contexts = this.contexts.filter((_, i) => !absorbed.has(i));
        return absorptions;
    }

    getStartStates(trueVars, log = () => {}) {
        if (this.pattern.elements.length === 0) return [];
        const initCounts = new Array(this.pattern.maxDepth + 1).fill(0);
        const initState = new MatchState(0, initCounts);
        const waitStates = this.expandToWaitPositions([initState]);

        const valid = [];
        for (const state of waitStates) {
            if (state.elementIndex === -1) continue;
            const elem = this.pattern.elements[state.elementIndex];
            if (!elem) continue;
            if (elem.isVar() && trueVars.includes(elem.varName)) {
                valid.push(state);
            } else if (elem.isAltStart()) {
                let altIdx = elem.next;
                while (altIdx >= 0 && altIdx < this.pattern.elements.length) {
                    const altElem = this.pattern.elements[altIdx];
                    if (altElem && altElem.isVar() && trueVars.includes(altElem.varName)) {
                        const altState = state.clone();
                        altState.elementIndex = altIdx;
                        valid.push(altState);
                    }
                    altIdx = altElem ? altElem.jump : -1;
                }
            }
        }
        return valid;
    }
}

// ============== Exports ==============

if (typeof window !== 'undefined') {
    window.MatchState = MatchState;
    window.MatchContext = MatchContext;
    window.NFAExecutor = NFAExecutor;
}

if (typeof module !== 'undefined' && module.exports) {
    const parser = require('./parser.js');
    module.exports = {
        PatternElement: parser.PatternElement,
        Pattern: parser.Pattern,
        parsePattern: parser.parsePattern,
        MatchState,
        MatchContext,
        NFAExecutor
    };
}
