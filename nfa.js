// ============== NFA Runtime (RPR_NFA_CONCEPT.md) ==============
// Requires: parser.js

/**
 * Global sequence counter for Lexical Order tracking
 * Each path gets a sequence number when created, preserving creation order
 */
let _pathSeq = 0;

function resetPathSeq() {
    _pathSeq = 0;
}

/**
 * Summary: Aggregate values and paths
 * - aggregates: {} (placeholder for SUM, COUNT, FIRST, LAST, MIN, MAX)
 * - paths: Array of {seq, path} objects for Lexical Order preservation
 */
class Summary {
    constructor(paths = [[]]) {
        this.aggregates = {};  // Future: { sum: 0, count: 0, first: null, last: null, min: null, max: null }
        // Convert plain arrays to {seq, path} objects if needed
        this.paths = paths.map(p => {
            if (Array.isArray(p)) {
                return { seq: _pathSeq++, path: [...p] };
            }
            return { seq: p.seq, path: [...p.path] };
        });
    }

    clone() {
        const s = new Summary([]);
        s.paths = this.paths.map(p => ({ seq: p.seq, path: [...p.path] }));
        s.aggregates = { ...this.aggregates };
        return s;
    }

    // Clone with new sequence numbers for forking (branch point)
    fork() {
        const s = new Summary([]);
        s.paths = this.paths.map(p => ({ seq: _pathSeq++, path: [...p.path] }));
        s.aggregates = { ...this.aggregates };
        return s;
    }

    withMatch(varId) {
        const s = this.clone();
        s.paths = s.paths.map(p => ({ seq: p.seq, path: [...p.path, varId] }));
        return s;
    }

    mergePaths(other) {
        const existing = new Set(this.paths.map(p => p.path.join(',')));
        for (const p of other.paths) {
            const key = p.path.join(',');
            if (!existing.has(key)) {
                this.paths.push({ seq: p.seq, path: [...p.path] });
                existing.add(key);
            }
        }
    }

    // Check if aggregates are equal (for Summary merge)
    aggregatesEqual(other) {
        const keys1 = Object.keys(this.aggregates);
        const keys2 = Object.keys(other.aggregates);
        if (keys1.length !== keys2.length) return false;
        return keys1.every(k => this.aggregates[k] === other.aggregates[k]);
    }

    // Get paths sorted by sequence number (Lexical Order)
    getSortedPaths() {
        return [...this.paths].sort((a, b) => a.seq - b.seq).map(p => p.path);
    }
}

/**
 * MatchState: NFA runtime state
 * - elementIndex: current pattern position (-1 = completed)
 * - counts[]: repetition counts per depth level
 * - summaries[]: Summary array (maintains creation order)
 */
class MatchState {
    constructor(elementIndex, counts = [], summaries = null) {
        this.elementIndex = elementIndex;
        this.counts = [...counts];
        this.summaries = summaries
            ? summaries.map(s => s.clone())
            : [new Summary([[]])];
    }

    clone() {
        return new MatchState(
            this.elementIndex,
            [...this.counts],
            this.summaries
        );
    }

    // Fork with new sequence numbers for branch points (Lexical Order)
    fork() {
        const s = new MatchState(this.elementIndex, [...this.counts], null);
        s.summaries = this.summaries.map(sum => sum.fork());
        return s;
    }

    withMatch(varId) {
        const s = this.clone();
        s.summaries = s.summaries.map(sum => sum.withMatch(varId));
        return s;
    }

    /**
     * Merge summaries from another state
     * - Same aggregates → merge paths
     * - Different aggregates → add as new summary
     */
    mergeSummaries(other) {
        for (const otherSum of other.summaries) {
            // Find matching summary by aggregates
            const match = this.summaries.find(s => s.aggregatesEqual(otherSum));
            if (match) {
                match.mergePaths(otherSum);
            } else {
                this.summaries.push(otherSum.clone());
            }
        }
    }

    // Backward compatibility: get all paths from all summaries (sorted by Lexical Order)
    get matchedPaths() {
        const allPaths = [];
        for (const sum of this.summaries) {
            allPaths.push(...sum.paths);
        }
        // Sort by sequence number to preserve Lexical Order
        allPaths.sort((a, b) => a.seq - b.seq);
        return allPaths.map(p => p.path);
    }

    // Get paths with sequence info for Lexical Order tracking
    get matchedPathsWithSeq() {
        const allPaths = [];
        for (const sum of this.summaries) {
            allPaths.push(...sum.paths);
        }
        return allPaths;  // Array of {seq, path}
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
        this.completedPaths = [];    // Array of {seq, path} for Lexical Order
        this._pathSet = new Set();
        this._greedyFallback = null;  // Best path preserved for greedy fallback
    }

    addCompletedPath(path, seq = Infinity) {
        if (!path || path.length === 0) return;
        const key = path.join(',');
        if (!this._pathSet.has(key)) {
            this._pathSet.add(key);
            this.completedPaths.push({ seq, path: [this.id, ...path] });
        }
    }

    // Get completed paths sorted by Lexical Order (seq)
    getSortedCompletedPaths() {
        return [...this.completedPaths].sort((a, b) => a.seq - b.seq).map(p => p.path);
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
        _pathSeq = 0;
    }

    reset() {
        this.contexts = [];
        this.currentRow = -1;
        this.history = [];
        _ctxId = 0;
        _pathSeq = 0;
    }

    /**
     * Convert variable names to varIds using pattern.variables
     */
    toVarIds(varNames) {
        const varIds = new Set();
        for (const name of varNames) {
            const idx = this.pattern.variables.indexOf(name);
            if (idx >= 0) {
                varIds.add(idx);
            }
        }
        return varIds;
    }

    /**
     * Process one row of input
     * @param {string[]} trueVarNames - Array of variable names that are true for this row
     */
    processRow(trueVarNames) {
        const trueVars = this.toVarIds(trueVarNames);
        this.currentRow++;
        const row = this.currentRow;
        const logs = [];
        const log = (msg, type = 'info') => logs.push({ message: msg, type });
        const stateMerges = [];

        const trueVarNamesForLog = Array.from(trueVars).map(id => this.pattern.variables[id]);
        log(`Processing row ${row}: [${trueVarNamesForLog.join(', ') || 'none'}]`);

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
        const toVarNames = path => path.map(id => this.pattern.variables[id]);
        const contextSnapshot = this.contexts
            .filter(ctx => ctx.states.length > 0 || ctx.isCompleted || deadContextIds.has(ctx.id))
            .map(ctx => ({
                id: ctx.id,
                matchStart: ctx.matchStart,
                matchEnd: ctx.matchEnd,
                isCompleted: ctx.isCompleted,
                isDead: ctx.states.length === 0 && !ctx.isCompleted,
                completedPaths: ctx.getSortedCompletedPaths().map(p => [p[0], ...toVarNames(p.slice(1))]),  // [ctxId, ...varNames]
                states: ctx.states.map(s => ({
                    elementIndex: s.elementIndex,
                    counts: [...s.counts],
                    matchedPaths: s.matchedPaths.map(p => toVarNames(p))  // Convert to var names
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

            if (elem.isVar() && trueVars.has(elem.varId)) {
                consumableStates.push(state);
            } else if (elem.isAltStart()) {
                // Check each alternative
                let altIdx = elem.next;
                while (altIdx >= 0 && altIdx < this.pattern.elements.length) {
                    const altElem = this.pattern.elements[altIdx];
                    if (altElem && altElem.isVar() && trueVars.has(altElem.varId)) {
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
        let nextWaitStates = this.expandToWaitPositions(activeStates);

        // Filter out non-viable states (when no pattern variable matches)
        const hasPatternMatch = trueVars.size > 0;
        if (!hasPatternMatch) {
            nextWaitStates = this.filterNonViableStates(nextWaitStates, trueVars);
        }

        // Separate completed from active (use index map for order preservation)
        const completedIndex = {};
        for (let i = 0; i < completedStates.length; i++) {
            completedIndex[completedStates[i].hash()] = i;
        }

        for (const state of nextWaitStates) {
            if (state.elementIndex === -1) {
                const hash = state.hash();
                if (hash in completedIndex) {
                    completedStates[completedIndex[hash]].mergeSummaries(state);
                } else {
                    completedIndex[hash] = completedStates.length;
                    completedStates.push(state);
                }
            } else {
                ctx.states.push(state);
            }
        }

        // Merge duplicate active states
        ctx.states = this.mergeStates(ctx.states, stateMerges, ctx.id);

        // Extract completed paths with Lexical Order (seq)
        for (const state of completedStates) {
            for (const p of state.matchedPathsWithSeq) {
                ctx.addCompletedPath(p.path, p.seq);
            }
        }

        // Set matchEnd based on actual path lengths (exclude ID prefix)
        if (ctx.completedPaths.length > 0) {
            const maxLen = Math.max(...ctx.completedPaths.map(p => p.path.length - 1));
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
        let nextWaitStates = this.expandToWaitPositions(activeStates);

        // Filter out non-viable states (when no pattern variable matches)
        const hasPatternMatch = trueVars.size > 0;
        if (!hasPatternMatch) {
            nextWaitStates = this.filterNonViableStates(nextWaitStates, trueVars);
        }

        // Separate completed from active (use index map for order preservation)
        const completedIndex = {};
        for (let i = 0; i < completedStates.length; i++) {
            completedIndex[completedStates[i].hash()] = i;
        }

        ctx.states = [];
        for (const state of nextWaitStates) {
            if (state.elementIndex === -1) {
                const hash = state.hash();
                if (hash in completedIndex) {
                    completedStates[completedIndex[hash]].mergeSummaries(state);
                } else {
                    completedIndex[hash] = completedStates.length;
                    completedStates.push(state);
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
                return trueVars.has(elem.varId);
            } else if (elem.isAltStart()) {
                // Check if any alternative can match
                let altIdx = elem.next;
                while (altIdx >= 0 && altIdx < this.pattern.elements.length) {
                    const altElem = this.pattern.elements[altIdx];
                    if (altElem && altElem.isVar() && trueVars.has(altElem.varId)) {
                        return true;
                    }
                    altIdx = altElem ? altElem.jump : -1;
                }
            }
            return false;
        });

        if (completedStates.length > 0 && ctx.states.length > 0 && canProgressFurther && hasPatternMatch) {
            // Active states exist and input has pattern variables - can potentially match longer
            // Greedy: preserve best completion for fallback, replace if longer found

            // Collect all completed paths with their info (with seq for Lexical Order)
            const allCompletedPaths = [];
            for (const state of completedStates) {
                for (const p of state.matchedPathsWithSeq) {
                    allCompletedPaths.push(p);  // {seq, path}
                }
            }

            // Select best path: longest first, keep Lexical Order (seq) for same length
            if (allCompletedPaths.length > 0) {
                // Sort by length desc, then by seq asc
                allCompletedPaths.sort((a, b) => {
                    if (b.path.length !== a.path.length) return b.path.length - a.path.length;
                    return a.seq - b.seq;
                });

                const bestPath = allCompletedPaths[0];

                // Replace greedy fallback if new best is longer
                if (!ctx._greedyFallback || bestPath.path.length > ctx._greedyFallback.path.length) {
                    ctx._greedyFallback = { seq: bestPath.seq, path: [...bestPath.path] };
                    log(`Greedy: updating fallback to: ${bestPath.path.map(id => this.pattern.variables[id]).join(' ')}`, 'warning');
                }

                // Mark all as discarded (they're just candidates, not final)
                for (const p of allCompletedPaths) {
                    discardedStates.push({
                        contextId: ctx.id,
                        elementIndex: -1, // #FIN
                        counts: [],
                        matchedPaths: [p.path],
                        reason: 'greedy_defer'
                    });
                }
            }
        } else {
            // No active states, or can't progress further, or no pattern match
            // Finalize: add greedy fallback if exists, then all current completed paths (with Lexical Order)
            if (ctx._greedyFallback) {
                ctx.addCompletedPath(ctx._greedyFallback.path, ctx._greedyFallback.seq);
                ctx._greedyFallback = null;
            }
            for (const state of completedStates) {
                for (const p of state.matchedPathsWithSeq) {
                    ctx.addCompletedPath(p.path, p.seq);
                }
            }
        }

        // Update matchEnd based on actual path lengths (exclude ID prefix)
        if (ctx.completedPaths.length > 0) {
            const maxLen = Math.max(...ctx.completedPaths.map(p => p.path.length - 1));
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
     * Returns { activeStates: Array, completedStates: Array, deadStates: Array }
     *
     * Uses arrays instead of Map to preserve Lexical Order (insertion order).
     * When states have the same hash, paths are merged but order is preserved.
     */
    consumeInput(states, trueVars, log, stateMerges, ctxId) {
        const activeStates = [];      // Array to preserve insertion order
        const activeIndex = {};       // hash -> index in activeStates
        const completedStates = [];   // Array to preserve insertion order
        const completedIndex = {};    // hash -> index in completedStates
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
                    // Completed state
                    if (hash in completedIndex) {
                        completedStates[completedIndex[hash]].mergeSummaries(newState);
                    } else {
                        completedIndex[hash] = completedStates.length;
                        completedStates.push(newState);
                    }
                } else {
                    // Active state
                    if (hash in activeIndex) {
                        activeStates[activeIndex[hash]].mergeSummaries(newState);
                    } else {
                        activeIndex[hash] = activeStates.length;
                        activeStates.push(newState);
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
            results.push(new MatchState(-1, state.counts, state.summaries));
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
            results.push(new MatchState(-1, state.counts, state.summaries));
        }

        return results;
    }

    /**
     * VAR transition
     * Greedy: prefer staying (more matches) over advancing
     * Reluctant: prefer advancing (fewer matches) over staying
     */
    transitionVar(state, elem, trueVars, log, results) {
        const matches = trueVars.has(elem.varId);
        const count = state.counts[elem.depth] || 0;
        const varName = this.pattern.variables[elem.varId];

        if (matches) {
            const newCount = count + 1;
            const newState = state.withMatch(elem.varId);
            newState.counts[elem.depth] = newCount;

            if (newCount >= elem.max) {
                // Max reached - must advance
                newState.counts[elem.depth] = 0;
                newState.elementIndex = elem.next;
                results.push(newState);
                log(`${varName} matched (max=${elem.max}), advancing`);
            } else if (newCount >= elem.min && elem.reluctant) {
                // Reluctant: min satisfied - prefer advance, but also stay
                // Add advance first (higher priority for reluctant)
                const advanceState = newState.clone();
                advanceState.counts[elem.depth] = 0;
                advanceState.elementIndex = elem.next;
                results.push(advanceState);
                log(`${varName} matched (${newCount}), reluctant advancing`);

                // Also stay (lower priority) - fork for new seq
                const stayState = newState.fork();
                results.push(stayState);
                log(`${varName} matched (${newCount}), reluctant also staying`);
            } else {
                // Greedy or min not yet satisfied: stay at VAR (can match more)
                results.push(newState);
                log(`${varName} matched (${newCount}), staying`);

                // Greedy: also fork to advance if min satisfied
                if (newCount >= elem.min && !elem.reluctant) {
                    const advanceState = newState.fork();  // fork for new seq
                    advanceState.counts[elem.depth] = 0;
                    advanceState.elementIndex = elem.next;
                    results.push(advanceState);
                    log(`${varName} matched (${newCount}), greedy also advancing`);
                }
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
                log(`${varName} not matched, min satisfied, advancing`);
            } else {
                log(`${varName} not matched, count=${count}<min=${elem.min}, DEAD`);
            }
        }
    }

    /**
     * #ALT transition - try each alternative in Lexical Order
     * First alternative keeps original seq, subsequent alternatives fork for new seq
     */
    transitionAlt(state, elem, trueVars, log, results) {
        let anyMatched = false;
        let isFirst = true;

        // Try each alternative
        let altIdx = elem.next;
        while (altIdx >= 0 && altIdx < this.pattern.elements.length) {
            const altElem = this.pattern.elements[altIdx];
            // First alternative: clone (keep seq), others: fork (new seq)
            const altState = isFirst ? state.clone() : state.fork();
            altState.elementIndex = altIdx;

            const subResults = this.transition(altState, trueVars, log);
            if (subResults.length > 0) {
                anyMatched = true;
                results.push(...subResults);
            }

            isFirst = false;
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
     * Greedy: prefer repeat (more iterations) over exit
     * Reluctant: prefer exit (fewer iterations) over repeat
     */
    transitionGroupEnd(state, elem, log, results) {
        const count = (state.counts[elem.depth] || 0) + 1;

        if (count < elem.min) {
            // Must repeat (both greedy and reluctant)
            const repeatState = state.clone();
            repeatState.counts[elem.depth] = count;
            this.resetInnerCounts(repeatState, elem.depth);
            repeatState.elementIndex = elem.jump;
            results.push(repeatState);
            log(`Group end: count=${count}<min=${elem.min}, must repeat`);
        } else if (count >= elem.max) {
            // Max reached - must exit (both greedy and reluctant)
            const exitState = state.clone();
            exitState.counts[elem.depth] = 0;
            exitState.elementIndex = elem.next;
            results.push(exitState);
            log(`Group end: count=${count}=max, exiting`);
        } else if (elem.reluctant) {
            // Reluctant: prefer exit, but also allow repeat
            const exitState = state.clone();
            exitState.counts[elem.depth] = 0;
            exitState.elementIndex = elem.next;
            results.push(exitState);
            log(`Group end: count=${count}, reluctant exiting`);

            // fork for second branch (new seq)
            const repeatState = state.fork();
            repeatState.counts[elem.depth] = count;
            this.resetInnerCounts(repeatState, elem.depth);
            repeatState.elementIndex = elem.jump;
            results.push(repeatState);
            log(`Group end: count=${count}, reluctant also repeating`);
        } else {
            // Greedy: prefer repeat, but also allow exit
            const repeatState = state.clone();
            repeatState.counts[elem.depth] = count;
            this.resetInnerCounts(repeatState, elem.depth);
            repeatState.elementIndex = elem.jump;
            results.push(repeatState);
            log(`Group end: count=${count}, greedy repeating`);

            // fork for second branch (new seq)
            const exitState = state.fork();
            exitState.counts[elem.depth] = 0;
            exitState.elementIndex = elem.next;
            results.push(exitState);
            log(`Group end: count=${count}, greedy also exiting`);
        }
    }

    /**
     * Expand states to wait positions (VAR or #ALT)
     * Processes epsilon transitions (#END, #FIN)
     * Uses array-based tracking to preserve insertion order (Lexical Order)
     */
    expandToWaitPositions(states) {
        const result = [];
        const seen = [];         // Array to preserve insertion order
        const seenIndex = {};    // hash -> index in seen
        const queue = [...states];

        while (queue.length > 0) {
            const state = queue.shift();
            const hash = state.hash();

            if (hash in seenIndex) {
                seen[seenIndex[hash]].mergeSummaries(state);
                continue;
            }
            seenIndex[hash] = seen.length;
            seen.push(state);

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

                // Also explore skip path if min satisfied (fork for new seq)
                const count = state.counts[elem.depth] || 0;
                if (count >= elem.min) {
                    const skip = state.fork();
                    skip.counts[elem.depth] = 0;
                    skip.elementIndex = elem.next;
                    queue.push(skip);
                }
            } else if (elem.isAltStart()) {
                // Wait at #ALT
                result.push(state);

                // Also explore skip if group min satisfied (fork for new seq)
                const endElem = this.findGroupEnd(elem);
                if (endElem) {
                    const count = state.counts[endElem.depth] || 0;
                    if (count >= endElem.min) {
                        const skip = state.fork();
                        skip.counts[endElem.depth] = 0;
                        skip.elementIndex = endElem.next;
                        queue.push(skip);
                    }
                }
            } else if (elem.isGroupEnd()) {
                // Process #END (epsilon)
                // Greedy: repeat first, exit second
                // Reluctant: exit first, repeat second
                const count = (state.counts[elem.depth] || 0) + 1;

                if (count < elem.min) {
                    // Must repeat
                    const repeat = state.clone();
                    repeat.counts[elem.depth] = count;
                    this.resetInnerCounts(repeat, elem.depth);
                    repeat.elementIndex = elem.jump;
                    queue.push(repeat);
                } else if (count >= elem.max) {
                    // Must exit
                    const exit = state.clone();
                    exit.counts[elem.depth] = 0;
                    exit.elementIndex = elem.next;
                    queue.push(exit);
                } else if (elem.reluctant) {
                    // Reluctant: exit first
                    const exit = state.clone();
                    exit.counts[elem.depth] = 0;
                    exit.elementIndex = elem.next;
                    queue.push(exit);

                    // fork for second branch (new seq)
                    const repeat = state.fork();
                    repeat.counts[elem.depth] = count;
                    this.resetInnerCounts(repeat, elem.depth);
                    repeat.elementIndex = elem.jump;
                    queue.push(repeat);
                } else {
                    // Greedy: repeat first
                    const repeat = state.clone();
                    repeat.counts[elem.depth] = count;
                    this.resetInnerCounts(repeat, elem.depth);
                    repeat.elementIndex = elem.jump;
                    queue.push(repeat);

                    // fork for second branch (new seq)
                    const exit = state.fork();
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
     * Uses array-based tracking to preserve insertion order (Lexical Order)
     */
    mergeStates(states, stateMerges, ctxId) {
        const merged = [];         // Array to preserve insertion order
        const mergedIndex = {};    // hash -> index in merged
        for (const state of states) {
            const hash = state.hash();
            if (hash in mergedIndex) {
                merged[mergedIndex[hash]].mergeSummaries(state);
            } else {
                mergedIndex[hash] = merged.length;
                merged.push(state);
            }
        }
        return merged;
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
                if (trueVars.has(elem.varId)) return true;

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
            if (elem && elem.isVar() && trueVars.has(elem.varId)) {
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

    /**
     * Get valid start states for given input (for testing)
     * @param {string[]} trueVarNames - Array of variable names
     */
    getStartStates(trueVarNames) {
        const trueVars = this.toVarIds(trueVarNames);
        if (this.pattern.elements.length === 0) return [];
        const initCounts = new Array(this.pattern.maxDepth + 1).fill(0);
        const initState = new MatchState(0, initCounts);
        const waitStates = this.expandToWaitPositions([initState]);

        const valid = [];
        for (const state of waitStates) {
            if (state.elementIndex === -1) continue;
            const elem = this.pattern.elements[state.elementIndex];
            if (!elem) continue;
            if (elem.isVar() && trueVars.has(elem.varId)) {
                valid.push(state);
            } else if (elem.isAltStart()) {
                let altIdx = elem.next;
                while (altIdx >= 0 && altIdx < this.pattern.elements.length) {
                    const altElem = this.pattern.elements[altIdx];
                    if (altElem && altElem.isVar() && trueVars.has(altElem.varId)) {
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
    window.Summary = Summary;
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
        Summary,
        MatchState,
        MatchContext,
        NFAExecutor
    };
}
