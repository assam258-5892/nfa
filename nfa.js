// ============== NFA Runtime (docs/4 executor.txt) ==============
// Requires: parser.js

/**
 * Summary: Aggregate values and paths
 * - aggregates: {} (placeholder for SUM, COUNT, FIRST, LAST, MIN, MAX)
 * - paths: Array of paths (insertion order = Lexical Order)
 */
class Summary {
    constructor(paths) {
        if (paths === undefined) paths = [[]];
        this.aggregates = {};  // Future: { sum: 0, count: 0, first: null, last: null, min: null, max: null }
        this.paths = [];
        for (var i = 0; i < paths.length; i++) {
            var p = paths[i];
            var pathCopy = [];
            for (var j = 0; j < p.length; j++) pathCopy.push(p[j]);
            this.paths.push(pathCopy);
        }
    }

    clone() {
        var s = new Summary([]);
        s.paths = [];
        for (var i = 0; i < this.paths.length; i++) {
            var p = this.paths[i];
            var pathCopy = [];
            for (var j = 0; j < p.length; j++) pathCopy.push(p[j]);
            s.paths.push(pathCopy);
        }
        var keys = Object.keys(this.aggregates);
        for (var i = 0; i < keys.length; i++) {
            s.aggregates[keys[i]] = this.aggregates[keys[i]];
        }
        return s;
    }

    withMatch(varId) {
        var s = this.clone();
        for (var i = 0; i < s.paths.length; i++) {
            s.paths[i].push(varId);
        }
        return s;
    }

    mergePaths(other) {
        // Build existing set as object for O(1) lookup
        var existing = {};
        for (var i = 0; i < this.paths.length; i++) {
            existing[this.paths[i].join(',')] = true;
        }
        for (var i = 0; i < other.paths.length; i++) {
            var p = other.paths[i];
            var key = p.join(',');
            if (!existing[key]) {
                var pathCopy = [];
                for (var j = 0; j < p.length; j++) pathCopy.push(p[j]);
                this.paths.push(pathCopy);
                existing[key] = true;
            }
        }
    }

    // Check if aggregates are equal (for Summary merge)
    aggregatesEqual(other) {
        var keys1 = Object.keys(this.aggregates);
        var keys2 = Object.keys(other.aggregates);
        if (keys1.length !== keys2.length) return false;
        for (var i = 0; i < keys1.length; i++) {
            var k = keys1[i];
            if (this.aggregates[k] !== other.aggregates[k]) return false;
        }
        return true;
    }

    // Get paths in insertion order (Lexical Order)
    getPaths() {
        var result = [];
        for (var i = 0; i < this.paths.length; i++) {
            var pathCopy = [];
            for (var j = 0; j < this.paths[i].length; j++) {
                pathCopy.push(this.paths[i][j]);
            }
            result.push(pathCopy);
        }
        return result;
    }
}

/**
 * MatchState: NFA runtime state
 * - elementIndex: current pattern position (-1 = completed)
 * - counts[]: repetition counts per depth level
 * - summaries[]: Summary array (maintains creation order)
 */
class MatchState {
    constructor(elementIndex, counts, summaries) {
        if (counts === undefined) counts = [];
        this.elementIndex = elementIndex;
        this.counts = [];
        for (var i = 0; i < counts.length; i++) this.counts.push(counts[i]);
        if (summaries) {
            this.summaries = [];
            for (var i = 0; i < summaries.length; i++) {
                this.summaries.push(summaries[i].clone());
            }
        } else {
            this.summaries = [new Summary([[]])];
        }
    }

    clone() {
        var countsCopy = [];
        for (var i = 0; i < this.counts.length; i++) countsCopy.push(this.counts[i]);
        return new MatchState(this.elementIndex, countsCopy, this.summaries);
    }


    withMatch(varId) {
        var s = this.clone();
        for (var i = 0; i < s.summaries.length; i++) {
            s.summaries[i] = s.summaries[i].withMatch(varId);
        }
        return s;
    }

    /**
     * Merge summaries from another state
     * - Same aggregates → merge paths
     * - Different aggregates → add as new summary
     */
    mergeSummaries(other) {
        for (var i = 0; i < other.summaries.length; i++) {
            var otherSum = other.summaries[i];
            // Find matching summary by aggregates
            var match = null;
            for (var j = 0; j < this.summaries.length; j++) {
                if (this.summaries[j].aggregatesEqual(otherSum)) {
                    match = this.summaries[j];
                    break;
                }
            }
            if (match) {
                match.mergePaths(otherSum);
            } else {
                this.summaries.push(otherSum.clone());
            }
        }
    }

    // Get all paths from all summaries (insertion order = Lexical Order)
    getMatchedPaths() {
        var allPaths = [];
        for (var i = 0; i < this.summaries.length; i++) {
            var sum = this.summaries[i];
            for (var j = 0; j < sum.paths.length; j++) {
                allPaths.push(sum.paths[j]);
            }
        }
        return allPaths;
    }

    // Getter for backward compatibility
    get matchedPaths() {
        return this.getMatchedPaths();
    }

    hash() {
        return this.elementIndex + ':' + this.counts.join(',');
    }
}

/**
 * MatchContext: Group of states with same matchStart
 */
var _ctxId = 0;

class MatchContext {
    constructor(matchStart) {
        this.id = _ctxId++;
        this.matchStart = matchStart;
        this.matchEnd = -1;
        this.isCompleted = false;
        this.states = [];
        this.completedPaths = [];    // Array of paths (insertion order = Lexical Order)
        this._pathSet = {};          // Object instead of Set for path dedup
        this._greedyFallback = null;  // Best path preserved for greedy fallback
    }

    addCompletedPath(path) {
        if (!path || path.length === 0) return;
        var key = path.join(',');
        if (!this._pathSet[key]) {
            this._pathSet[key] = true;
            var newPath = [this.id];
            for (var i = 0; i < path.length; i++) newPath.push(path[i]);
            this.completedPaths.push(newPath);
        }
    }

    // Get completed paths in insertion order (Lexical Order)
    getCompletedPaths() {
        var result = [];
        for (var i = 0; i < this.completedPaths.length; i++) {
            var pathCopy = [];
            for (var j = 0; j < this.completedPaths[i].length; j++) {
                pathCopy.push(this.completedPaths[i][j]);
            }
            result.push(pathCopy);
        }
        return result;
    }
}

// SKIP mode constants
var SKIP_PAST_LAST = 'PAST_LAST';
var SKIP_TO_NEXT = 'TO_NEXT';

// Output mode constants
var OUTPUT_ONE_ROW = 'ONE_ROW';
var OUTPUT_ALL_ROWS = 'ALL_ROWS';

/**
 * NFAExecutor: Main execution engine
 */
class NFAExecutor {
    constructor(pattern, options) {
        if (options === undefined) options = {};
        this.pattern = pattern;
        this.contexts = [];
        this.currentRow = -1;
        this.history = [];
        // SKIP mode: PAST_LAST (default) or TO_NEXT
        this.skipMode = options.skipMode || SKIP_PAST_LAST;
        // Output mode: ONE_ROW (default) or ALL_ROWS
        this.outputMode = options.outputMode || OUTPUT_ONE_ROW;
        // Completed contexts queue (for emit ordering)
        this.completedContexts = [];
        // Emitted results
        this.emittedResults = [];
        // Last emitted matchEnd (for PAST_LAST mode)
        this.lastEmittedEnd = -1;
        _ctxId = 0;
    }

    reset() {
        this.contexts = [];
        this.currentRow = -1;
        this.history = [];
        this.completedContexts = [];
        this.emittedResults = [];
        this.lastEmittedEnd = -1;
        _ctxId = 0;
    }

    /**
     * Convert variable names to varIds using pattern.variables
     * Returns object with varId as key for O(1) lookup (like Set)
     */
    toVarIds(varNames) {
        var varIds = {};
        for (var i = 0; i < varNames.length; i++) {
            var name = varNames[i];
            var idx = this.pattern.variables.indexOf(name);
            if (idx >= 0) {
                varIds[idx] = true;
            }
        }
        return varIds;
    }

    // Helper: check if varId is in varIds object
    hasVarId(varIds, varId) {
        return varIds[varId] === true;
    }

    // Helper: get varIds count
    varIdsSize(varIds) {
        return Object.keys(varIds).length;
    }

    /**
     * Process one row of input
     * @param {string[]} trueVarNames - Array of variable names that are true for this row
     */
    processRow(trueVarNames) {
        var self = this;
        var trueVars = this.toVarIds(trueVarNames);
        this.currentRow++;
        var row = this.currentRow;
        var logs = [];
        function log(msg, type) {
            if (type === undefined) type = 'info';
            logs.push({ message: msg, type: type });
        }
        var stateMerges = [];

        var trueVarIds = Object.keys(trueVars);
        var trueVarNamesForLog = [];
        for (var i = 0; i < trueVarIds.length; i++) {
            trueVarNamesForLog.push(self.pattern.variables[parseInt(trueVarIds[i])]);
        }
        log('Processing row ' + row + ': [' + (trueVarNamesForLog.join(', ') || 'none') + ']');

        // 1. Try to start new context
        this.tryStartNewContext(row, trueVars, log, stateMerges);

        // 2. Process existing contexts
        var discardedStates = [];
        var deadStates = [];
        for (var i = 0; i < this.contexts.length; i++) {
            var ctx = this.contexts[i];
            if (ctx.isCompleted || ctx.matchStart === row) continue;
            var result = this.processContext(ctx, row, trueVars, log, stateMerges);
            if (result) {
                if (result.discardedStates) {
                    for (var j = 0; j < result.discardedStates.length; j++) {
                        discardedStates.push(result.discardedStates[j]);
                    }
                }
                if (result.deadStates) {
                    for (var j = 0; j < result.deadStates.length; j++) {
                        deadStates.push(result.deadStates[j]);
                    }
                }
            }
        }

        // 3. Context absorption
        var absorptions = this.absorbContexts(log);

        // 4. Snapshot for history
        // Include contexts that have states, are completed, or have dead states in this row
        var deadContextIds = {};
        for (var i = 0; i < deadStates.length; i++) {
            deadContextIds[deadStates[i].contextId] = true;
        }

        function toVarNames(path) {
            var result = [];
            for (var i = 0; i < path.length; i++) {
                result.push(self.pattern.variables[path[i]]);
            }
            return result;
        }

        var contextSnapshot = [];
        for (var i = 0; i < this.contexts.length; i++) {
            var ctx = this.contexts[i];
            if (ctx.states.length > 0 || ctx.isCompleted || deadContextIds[ctx.id]) {
                var completedPathsMapped = [];
                var sortedPaths = ctx.getCompletedPaths();
                for (var j = 0; j < sortedPaths.length; j++) {
                    var p = sortedPaths[j];
                    var mapped = [p[0]];
                    for (var k = 1; k < p.length; k++) {
                        mapped.push(self.pattern.variables[p[k]]);
                    }
                    completedPathsMapped.push(mapped);
                }

                var statesMapped = [];
                for (var j = 0; j < ctx.states.length; j++) {
                    var s = ctx.states[j];
                    var countsCopy = [];
                    for (var k = 0; k < s.counts.length; k++) countsCopy.push(s.counts[k]);
                    var pathsMapped = [];
                    var matchedPaths = s.matchedPaths;
                    for (var k = 0; k < matchedPaths.length; k++) {
                        pathsMapped.push(toVarNames(matchedPaths[k]));
                    }
                    statesMapped.push({
                        elementIndex: s.elementIndex,
                        counts: countsCopy,
                        matchedPaths: pathsMapped
                    });
                }

                contextSnapshot.push({
                    id: ctx.id,
                    matchStart: ctx.matchStart,
                    matchEnd: ctx.matchEnd,
                    isCompleted: ctx.isCompleted,
                    isDead: ctx.states.length === 0 && !ctx.isCompleted,
                    completedPaths: completedPathsMapped,
                    states: statesMapped
                });
            }
        }

        var inputCopy = [];
        var trueVarKeys = Object.keys(trueVars);
        for (var i = 0; i < trueVarKeys.length; i++) {
            inputCopy.push(parseInt(trueVarKeys[i]));
        }
        // 5. Queue completed contexts and emit results
        var emitResult = this.emitRows(log);

        this.history.push({ row: row, input: inputCopy, contexts: contextSnapshot, absorptions: absorptions, stateMerges: stateMerges, discardedStates: discardedStates, deadStates: deadStates, logs: logs, emitted: emitResult.emitted, queued: emitResult.queued, discarded: emitResult.discarded });

        // 6. Remove dead/completed contexts
        var aliveContexts = [];
        for (var i = 0; i < this.contexts.length; i++) {
            var ctx = this.contexts[i];
            if (ctx.states.length > 0 && !ctx.isCompleted) {
                aliveContexts.push(ctx);
            }
        }
        this.contexts = aliveContexts;

        return { row: row, contexts: contextSnapshot, absorptions: absorptions, stateMerges: stateMerges, discardedStates: discardedStates, deadStates: deadStates, logs: logs, emitted: emitResult.emitted, queued: emitResult.queued, discarded: emitResult.discarded };
    }

    /**
     * Emit completed matches based on SKIP mode
     * Overview 5.5:
     * - contexts[0] completed → emit immediately
     * - contexts[1+] completed → queue in completedContexts
     * - After emit, process queue by start order:
     *   1. start >= current contexts[0].start → stop (not yet eligible)
     *   2. PAST LAST: start <= lastEmittedEnd → discard, continue
     *   3. TO NEXT: end >= contexts[0].start (overlaps) → stop (wait)
     *   4. TO NEXT: end < contexts[0].start (no overlap) → emit, continue
     */
    emitRows(log) {
        var emitted = [];
        var queued = [];
        var discarded = [];

        // Find the earliest matchStart among all contexts (completed or not)
        var earliestStart = Infinity;
        for (var i = 0; i < this.contexts.length; i++) {
            if (this.contexts[i].matchStart < earliestStart) {
                earliestStart = this.contexts[i].matchStart;
            }
        }
        // Also check completedContexts queue
        for (var i = 0; i < this.completedContexts.length; i++) {
            if (this.completedContexts[i].matchStart < earliestStart) {
                earliestStart = this.completedContexts[i].matchStart;
            }
        }

        // Check if there's any non-completed context at earliestStart
        var hasActiveAtEarliest = false;
        for (var i = 0; i < this.contexts.length; i++) {
            if (this.contexts[i].matchStart === earliestStart && !this.contexts[i].isCompleted) {
                hasActiveAtEarliest = true;
                break;
            }
        }

        // Move completed contexts to queue, but emit immediately if it's the earliest AND no active context at same start
        for (var i = 0; i < this.contexts.length; i++) {
            var ctx = this.contexts[i];
            if (ctx.isCompleted && ctx.completedPaths.length > 0) {
                // Check if already in queue
                var inQueue = false;
                for (var j = 0; j < this.completedContexts.length; j++) {
                    if (this.completedContexts[j].id === ctx.id) {
                        inQueue = true;
                        break;
                    }
                }
                if (!inQueue) {
                    // Emit immediately only if: earliest start AND no active context at same start
                    if (ctx.matchStart === earliestStart && !hasActiveAtEarliest) {
                        // Check SKIP mode constraints before immediate emit
                        var shouldEmit = true;
                        if (this.skipMode === SKIP_PAST_LAST && ctx.matchStart <= this.lastEmittedEnd) {
                            discarded.push({ contextId: ctx.id, matchStart: ctx.matchStart, matchEnd: ctx.matchEnd, reason: 'SKIP PAST LAST: overlaps with emitted match (start=' + ctx.matchStart + ' <= lastEnd=' + this.lastEmittedEnd + ')' });
                            if (log) log('🗑️ DISCARDED ctx #' + ctx.id + ' (rows ' + ctx.matchStart + '-' + ctx.matchEnd + ') - SKIP PAST LAST: overlaps with emitted match', 'warning');
                            shouldEmit = false;
                        }
                        if (shouldEmit) {
                            if (log) log('📤 EMITTING ctx #' + ctx.id + ' (rows ' + ctx.matchStart + '-' + ctx.matchEnd + ')', 'success');
                            var result = this.emitContext(ctx, log);
                            emitted.push(result);
                            this.lastEmittedEnd = ctx.matchEnd;
                        }
                    } else {
                        // Queue it: either not earliest, or has active context at same start
                        this.completedContexts.push(ctx);
                        queued.push({ contextId: ctx.id, matchStart: ctx.matchStart, matchEnd: ctx.matchEnd });
                        if (log) log('📥 QUEUED ctx #' + ctx.id + ' (rows ' + ctx.matchStart + '-' + ctx.matchEnd + ') - waiting for earlier contexts', 'info');
                    }
                }
            }
        }

        // Sort queue by matchStart
        this.completedContexts.sort(function(a, b) {
            return a.matchStart - b.matchStart;
        });

        // Get current active context start (first non-completed context)
        var activeCtxStart = Infinity;
        for (var i = 0; i < this.contexts.length; i++) {
            if (!this.contexts[i].isCompleted) {
                activeCtxStart = this.contexts[i].matchStart;
                break;
            }
        }

        // Process queue
        var toRemove = [];
        for (var i = 0; i < this.completedContexts.length; i++) {
            var ctx = this.completedContexts[i];

            // Rule 1: start >= activeCtxStart → stop (not yet eligible to emit)
            if (ctx.matchStart >= activeCtxStart) {
                break;
            }

            if (this.skipMode === SKIP_PAST_LAST) {
                // Rule 2: PAST LAST - start <= lastEmittedEnd → discard
                if (ctx.matchStart <= this.lastEmittedEnd) {
                    toRemove.push(i);
                    discarded.push({ contextId: ctx.id, matchStart: ctx.matchStart, matchEnd: ctx.matchEnd, reason: 'SKIP PAST LAST: overlaps with emitted match (start=' + ctx.matchStart + ' <= lastEnd=' + this.lastEmittedEnd + ')' });
                    if (log) log('🗑️ DISCARDED ctx #' + ctx.id + ' (rows ' + ctx.matchStart + '-' + ctx.matchEnd + ') - SKIP PAST LAST: overlaps with emitted match (start=' + ctx.matchStart + ' <= lastEnd=' + this.lastEmittedEnd + ')', 'warning');
                    continue;
                }
            } else if (this.skipMode === SKIP_TO_NEXT) {
                // Rule 3: TO NEXT - end >= activeCtxStart → stop (wait for active to complete)
                if (ctx.matchEnd >= activeCtxStart) {
                    break;
                }
                // Rule 4: TO NEXT - end < activeCtxStart → emit
            }

            // Emit this context
            if (log) log('📤 EMITTING ctx #' + ctx.id + ' (rows ' + ctx.matchStart + '-' + ctx.matchEnd + ')', 'success');
            var result = this.emitContext(ctx, log);
            emitted.push(result);
            toRemove.push(i);
            this.lastEmittedEnd = ctx.matchEnd;
        }

        // Remove emitted/discarded from queue (reverse order to preserve indices)
        for (var i = toRemove.length - 1; i >= 0; i--) {
            this.completedContexts.splice(toRemove[i], 1);
        }

        return { emitted: emitted, queued: queued, discarded: discarded };
    }

    /**
     * Emit a single context's match result
     */
    emitContext(ctx, log) {
        var self = this;
        var paths = ctx.getCompletedPaths();

        // Apply output mode
        var outputPaths;
        if (this.outputMode === OUTPUT_ONE_ROW) {
            // ONE ROW: only first path (Lexical Order best)
            outputPaths = paths.length > 0 ? [paths[0]] : [];
        } else {
            // ALL ROWS: all paths
            outputPaths = paths;
        }

        // Convert varIds to variable names
        var result = {
            contextId: ctx.id,
            matchStart: ctx.matchStart,
            matchEnd: ctx.matchEnd,
            paths: []
        };
        for (var i = 0; i < outputPaths.length; i++) {
            var path = outputPaths[i];
            // Skip first element (context id) in path
            var mapped = [];
            for (var j = 1; j < path.length; j++) {
                mapped.push(self.pattern.variables[path[j]]);
            }
            result.paths.push(mapped);
        }

        this.emittedResults.push(result);
        if (log) {
            var pathStr = result.paths.map(function(p) { return '[' + p.join(',') + ']'; }).join(', ');
            log('EMIT ctx #' + ctx.id + ' rows ' + ctx.matchStart + '-' + ctx.matchEnd + ': ' + pathStr, 'success');
        }

        return result;
    }

    /**
     * Try to start a new context
     */
    tryStartNewContext(row, trueVars, log, stateMerges) {
        if (this.pattern.elements.length === 0) return;

        // Initial state at element 0
        var initCounts = [];
        for (var i = 0; i <= this.pattern.maxDepth; i++) initCounts.push(0);
        var initState = new MatchState(0, initCounts);

        // Expand to wait positions (VAR or #ALT)
        var waitStates = this.expandToWaitPositions([initState]);

        // Find states that can consume input
        var consumableStates = [];
        for (var i = 0; i < waitStates.length; i++) {
            var state = waitStates[i];
            if (state.elementIndex === -1) continue;
            var elem = this.pattern.elements[state.elementIndex];
            if (!elem) continue;

            if (elem.isVar() && this.hasVarId(trueVars, elem.varId)) {
                consumableStates.push(state);
            } else if (elem.isAltStart()) {
                // Check each alternative (including nested ALTs)
                this.findConsumableAlternatives(state, elem, trueVars, consumableStates);
            }
        }

        if (consumableStates.length === 0) return;

        // Create new context
        var ctx = new MatchContext(row);

        // Consume input and generate next states
        var consumeResult = this.consumeInput(consumableStates, trueVars, log, stateMerges, ctx.id);
        var activeStates = consumeResult.activeStates;
        var completedStates = consumeResult.completedStates;

        // Expand active states to wait positions for next row
        var nextWaitStates = this.expandToWaitPositions(activeStates);

        // Filter out non-viable states (when no pattern variable matches)
        var hasPatternMatch = this.varIdsSize(trueVars) > 0;
        if (!hasPatternMatch) {
            nextWaitStates = this.filterNonViableStates(nextWaitStates, trueVars);
        }

        // Separate completed from active (use index map for order preservation)
        var completedIndex = {};
        for (var i = 0; i < completedStates.length; i++) {
            completedIndex[completedStates[i].hash()] = i;
        }

        for (var i = 0; i < nextWaitStates.length; i++) {
            var state = nextWaitStates[i];
            if (state.elementIndex === -1) {
                var hash = state.hash();
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

        // Extract completed paths (insertion order = Lexical Order)
        for (var i = 0; i < completedStates.length; i++) {
            var state = completedStates[i];
            var paths = state.matchedPaths;
            for (var j = 0; j < paths.length; j++) {
                ctx.addCompletedPath(paths[j]);
            }
        }

        // Set matchEnd based on actual path lengths (exclude ID prefix)
        if (ctx.completedPaths.length > 0) {
            var maxLen = 0;
            for (var i = 0; i < ctx.completedPaths.length; i++) {
                var len = ctx.completedPaths[i].length - 1;
                if (len > maxLen) maxLen = len;
            }
            ctx.matchEnd = ctx.matchStart + maxLen - 1;
            if (ctx.states.length === 0) {
                ctx.isCompleted = true;
                log('MATCH COMPLETE! rows ' + ctx.matchStart + '-' + ctx.matchEnd, 'success');
            } else {
                log('Potential match at rows ' + ctx.matchStart + '-' + ctx.matchEnd + ', continuing...', 'warning');
            }
        }

        if (ctx.states.length > 0 || ctx.isCompleted) {
            this.contexts.push(ctx);
            log('New context #' + ctx.id + ' started at row ' + row, 'success');
        }
    }

    /**
     * Process existing context
     * Returns { discardedStates, deadStates } for shorter match discards and mismatch deaths
     */
    processContext(ctx, row, trueVars, log, stateMerges) {
        var self = this;
        // Consume input from current wait states
        var consumeResult = this.consumeInput(ctx.states, trueVars, log, stateMerges, ctx.id);
        var activeStates = consumeResult.activeStates;
        var completedStates = consumeResult.completedStates;
        var deadStates = consumeResult.deadStates;

        // Expand to next wait positions
        var nextWaitStates = this.expandToWaitPositions(activeStates);

        // Filter out non-viable states (when no pattern variable matches)
        var hasPatternMatch = this.varIdsSize(trueVars) > 0;
        if (!hasPatternMatch) {
            nextWaitStates = this.filterNonViableStates(nextWaitStates, trueVars);
        }

        // Separate completed from active (use index map for order preservation)
        var completedIndex = {};
        for (var i = 0; i < completedStates.length; i++) {
            completedIndex[completedStates[i].hash()] = i;
        }

        ctx.states = [];
        for (var i = 0; i < nextWaitStates.length; i++) {
            var state = nextWaitStates[i];
            if (state.elementIndex === -1) {
                var hash = state.hash();
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
        var discardedStates = [];
        var canProgressFurther = false;
        for (var i = 0; i < ctx.states.length; i++) {
            var s = ctx.states[i];
            var elem = this.pattern.elements[s.elementIndex];
            if (!elem) continue;
            // Check if this state can actually consume current input
            if (elem.isVar()) {
                if (this.hasVarId(trueVars, elem.varId)) {
                    canProgressFurther = true;
                    break;
                }
            } else if (elem.isAltStart()) {
                // Check if any alternative can match
                var altIdx = elem.next;
                while (altIdx >= 0 && altIdx < this.pattern.elements.length) {
                    var altElem = this.pattern.elements[altIdx];
                    if (altElem && altElem.isVar() && this.hasVarId(trueVars, altElem.varId)) {
                        canProgressFurther = true;
                        break;
                    }
                    altIdx = altElem ? altElem.jump : -1;
                }
                if (canProgressFurther) break;
            }
        }

        // Pattern-level reluctant mode: if pattern.reluctant is true, don't defer completions
        // (first match wins immediately, no greedy fallback)
        var useGreedyMode = !this.pattern.reluctant;

        if (useGreedyMode && completedStates.length > 0 && ctx.states.length > 0 && canProgressFurther && hasPatternMatch) {
            // Active states exist and input has pattern variables - can potentially match longer
            // Greedy: preserve best completion for fallback, replace if longer found

            // Collect all completed paths (insertion order = Lexical Order)
            var allCompletedPaths = [];
            for (var i = 0; i < completedStates.length; i++) {
                var state = completedStates[i];
                var paths = state.matchedPaths;
                for (var j = 0; j < paths.length; j++) {
                    allCompletedPaths.push(paths[j]);
                }
            }

            // Select best path: first one with max length (Lexical Order preserved by insertion order)
            if (allCompletedPaths.length > 0) {
                var bestPath = allCompletedPaths[0];
                for (var i = 1; i < allCompletedPaths.length; i++) {
                    if (allCompletedPaths[i].length > bestPath.length) {
                        bestPath = allCompletedPaths[i];
                    }
                }

                // Replace greedy fallback if new best is longer
                if (!ctx._greedyFallback || bestPath.length > ctx._greedyFallback.length) {
                    var pathCopy = [];
                    for (var i = 0; i < bestPath.length; i++) pathCopy.push(bestPath[i]);
                    ctx._greedyFallback = pathCopy;
                    var varNames = [];
                    for (var i = 0; i < bestPath.length; i++) {
                        varNames.push(self.pattern.variables[bestPath[i]]);
                    }
                    log('Greedy: updating fallback to: ' + varNames.join(' '), 'warning');
                }

                // Mark all as discarded (they're just candidates, not final)
                for (var i = 0; i < allCompletedPaths.length; i++) {
                    discardedStates.push({
                        contextId: ctx.id,
                        elementIndex: -1, // #FIN
                        counts: [],
                        matchedPaths: [allCompletedPaths[i]],
                        reason: 'greedy_defer'
                    });
                }
            }
        } else {
            // No active states, or can't progress further, or no pattern match
            // Finalize: add greedy fallback if exists, then all current completed paths
            if (ctx._greedyFallback) {
                ctx.addCompletedPath(ctx._greedyFallback);
                ctx._greedyFallback = null;
            }
            for (var i = 0; i < completedStates.length; i++) {
                var state = completedStates[i];
                var paths = state.matchedPaths;
                for (var j = 0; j < paths.length; j++) {
                    ctx.addCompletedPath(paths[j]);
                }
            }
        }

        // Update matchEnd based on actual path lengths (exclude ID prefix)
        if (ctx.completedPaths.length > 0) {
            var maxLen = 0;
            for (var i = 0; i < ctx.completedPaths.length; i++) {
                var len = ctx.completedPaths[i].length - 1;
                if (len > maxLen) maxLen = len;
            }
            ctx.matchEnd = ctx.matchStart + maxLen - 1;
        }

        // Check completion
        if (ctx.states.length === 0) {
            if (ctx.completedPaths.length > 0 || ctx.matchEnd >= 0) {
                ctx.isCompleted = true;
                log('MATCH COMPLETE! rows ' + ctx.matchStart + '-' + ctx.matchEnd, 'success');
            } else {
                log('Context #' + ctx.id + ' died - no valid states', 'error');
            }
        } else if (ctx.completedPaths.length > 0) {
            log('Potential match at rows ' + ctx.matchStart + '-' + ctx.matchEnd + ', continuing...', 'warning');
        }

        return { discardedStates: discardedStates, deadStates: deadStates };
    }

    /**
     * Consume input from states and produce next states
     * Returns { activeStates: Array, completedStates: Array, deadStates: Array }
     *
     * Uses arrays instead of Map to preserve Lexical Order (insertion order).
     * When states have the same hash, paths are merged but order is preserved.
     */
    consumeInput(states, trueVars, log, stateMerges, ctxId) {
        var activeStates = [];      // Array to preserve insertion order
        var activeIndex = {};       // hash -> index in activeStates
        var completedStates = [];   // Array to preserve insertion order
        var completedIndex = {};    // hash -> index in completedStates
        var deadStates = [];

        for (var i = 0; i < states.length; i++) {
            var state = states[i];
            var results = this.transition(state, trueVars, log);
            if (results.length === 0) {
                // State died - mismatch
                var countsCopy = [];
                for (var j = 0; j < state.counts.length; j++) countsCopy.push(state.counts[j]);
                var pathsCopy = [];
                var matchedPaths = state.matchedPaths;
                for (var j = 0; j < matchedPaths.length; j++) {
                    var pCopy = [];
                    for (var k = 0; k < matchedPaths[j].length; k++) pCopy.push(matchedPaths[j][k]);
                    pathsCopy.push(pCopy);
                }
                deadStates.push({
                    contextId: ctxId,
                    elementIndex: state.elementIndex,
                    counts: countsCopy,
                    matchedPaths: pathsCopy,
                    reason: 'mismatch'
                });
            }
            for (var j = 0; j < results.length; j++) {
                var newState = results[j];
                var hash = newState.hash();
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

        return { activeStates: activeStates, completedStates: completedStates, deadStates: deadStates };
    }

    /**
     * Core transition function: consume input at current position
     */
    transition(state, trueVars, log) {
        var results = [];
        if (state.elementIndex === -1) return results;

        var elem = this.pattern.elements[state.elementIndex];
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
        var matches = this.hasVarId(trueVars, elem.varId);
        var count = state.counts[elem.depth] || 0;
        var varName = this.pattern.variables[elem.varId];

        if (matches) {
            var newCount = count + 1;
            var newState = state.withMatch(elem.varId);
            newState.counts[elem.depth] = newCount;

            if (newCount >= elem.max) {
                // Max reached - must advance
                newState.counts[elem.depth] = 0;
                newState.elementIndex = elem.next;
                results.push(newState);
                log(varName + ' matched (max=' + elem.max + '), advancing');
            } else if (newCount >= elem.min && elem.reluctant) {
                // Reluctant: min satisfied - prefer advance, but also stay
                // Add advance first (higher priority for reluctant)
                var advanceState = newState.clone();
                advanceState.counts[elem.depth] = 0;
                advanceState.elementIndex = elem.next;
                results.push(advanceState);
                log(varName + ' matched (' + newCount + '), reluctant advancing');

                // Also stay (lower priority) - fork for new seq
                var stayState = newState.clone();
                results.push(stayState);
                log(varName + ' matched (' + newCount + '), reluctant also staying');
            } else {
                // Greedy or min not yet satisfied: stay at VAR (can match more)
                results.push(newState);
                log(varName + ' matched (' + newCount + '), staying');

                // Greedy: also fork to advance if min satisfied
                if (newCount >= elem.min && !elem.reluctant) {
                    var advanceState2 = newState.clone();  // fork for new seq
                    advanceState2.counts[elem.depth] = 0;
                    advanceState2.elementIndex = elem.next;
                    results.push(advanceState2);
                    log(varName + ' matched (' + newCount + '), greedy also advancing');
                }
            }
        } else {
            // No match
            if (count >= elem.min) {
                // Min satisfied - advance without consuming
                var newState2 = state.clone();
                newState2.counts[elem.depth] = 0;
                newState2.elementIndex = elem.next;
                // Recursively transition to handle chained skips
                var subResults = this.transition(newState2, trueVars, log);
                for (var i = 0; i < subResults.length; i++) {
                    results.push(subResults[i]);
                }
                // If subResults is empty, the chain couldn't progress - don't add wait state
                log(varName + ' not matched, min satisfied, advancing');
            } else {
                log(varName + ' not matched, count=' + count + '<min=' + elem.min + ', DEAD');
            }
        }
    }

    /**
     * #ALT transition - try each alternative in Lexical Order
     * First alternative keeps original seq, subsequent alternatives fork for new seq
     */
    transitionAlt(state, elem, trueVars, log, results) {
        var anyMatched = false;
        var isFirst = true;

        // Try each alternative
        var altIdx = elem.next;
        while (altIdx >= 0 && altIdx < this.pattern.elements.length) {
            var altElem = this.pattern.elements[altIdx];
            // First alternative: clone (keep seq), others: fork (new seq)
            var altState = isFirst ? state.clone() : state.clone();
            altState.elementIndex = altIdx;

            var subResults = this.transition(altState, trueVars, log);
            if (subResults.length > 0) {
                anyMatched = true;
                for (var i = 0; i < subResults.length; i++) {
                    results.push(subResults[i]);
                }
            }

            isFirst = false;
            altIdx = altElem ? altElem.jump : -1;
        }

        // If nothing matched, try to exit group
        if (!anyMatched) {
            var endElem = this.findGroupEnd(elem);
            if (endElem) {
                var count = state.counts[endElem.depth] || 0;
                if (count >= endElem.min) {
                    var exitState = state.clone();
                    exitState.counts[endElem.depth] = 0;
                    exitState.elementIndex = endElem.next;
                    // Recursively transition to handle chained skips
                    var subResults2 = this.transition(exitState, trueVars, log);
                    if (subResults2.length > 0) {
                        for (var i = 0; i < subResults2.length; i++) {
                            results.push(subResults2[i]);
                        }
                    } else {
                        results.push(exitState);
                    }
                    log('No alternative matched, min=' + endElem.min + ' satisfied, exiting group');
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
        var count = (state.counts[elem.depth] || 0) + 1;

        if (count < elem.min) {
            // Must repeat (both greedy and reluctant)
            var repeatState = state.clone();
            repeatState.counts[elem.depth] = count;
            this.resetInnerCounts(repeatState, elem.depth);
            repeatState.elementIndex = elem.jump;
            results.push(repeatState);
            log('Group end: count=' + count + '<min=' + elem.min + ', must repeat');
        } else if (count >= elem.max) {
            // Max reached - must exit (both greedy and reluctant)
            var exitState = state.clone();
            exitState.counts[elem.depth] = 0;
            exitState.elementIndex = elem.next;
            results.push(exitState);
            log('Group end: count=' + count + '=max, exiting');
        } else if (elem.reluctant) {
            // Reluctant: prefer exit, but also allow repeat
            var exitState2 = state.clone();
            exitState2.counts[elem.depth] = 0;
            exitState2.elementIndex = elem.next;
            results.push(exitState2);
            log('Group end: count=' + count + ', reluctant exiting');

            // fork for second branch (new seq)
            var repeatState2 = state.clone();
            repeatState2.counts[elem.depth] = count;
            this.resetInnerCounts(repeatState2, elem.depth);
            repeatState2.elementIndex = elem.jump;
            results.push(repeatState2);
            log('Group end: count=' + count + ', reluctant also repeating');
        } else {
            // Greedy: prefer repeat, but also allow exit
            var repeatState3 = state.clone();
            repeatState3.counts[elem.depth] = count;
            this.resetInnerCounts(repeatState3, elem.depth);
            repeatState3.elementIndex = elem.jump;
            results.push(repeatState3);
            log('Group end: count=' + count + ', greedy repeating');

            // fork for second branch (new seq)
            var exitState3 = state.clone();
            exitState3.counts[elem.depth] = 0;
            exitState3.elementIndex = elem.next;
            results.push(exitState3);
            log('Group end: count=' + count + ', greedy also exiting');
        }
    }

    /**
     * Expand states to wait positions (VAR or #ALT)
     * Processes epsilon transitions (#END, #FIN)
     * Uses array-based tracking to preserve insertion order (Lexical Order)
     */
    expandToWaitPositions(states) {
        var result = [];
        var seen = [];         // Array to preserve insertion order
        var seenIndex = {};    // hash -> index in seen
        var queue = [];
        for (var i = 0; i < states.length; i++) queue.push(states[i]);

        while (queue.length > 0) {
            var state = queue.shift();
            var hash = state.hash();

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

            var elem = this.pattern.elements[state.elementIndex];
            if (!elem) {
                var fin = state.clone();
                fin.elementIndex = -1;
                result.push(fin);
                continue;
            }

            if (elem.isFinish()) {
                // #FIN - completed
                var fin2 = state.clone();
                fin2.elementIndex = -1;
                result.push(fin2);
            } else if (elem.isVar()) {
                // Wait at VAR
                result.push(state);

                // Also explore skip path if min satisfied (fork for new seq)
                var count = state.counts[elem.depth] || 0;
                if (count >= elem.min) {
                    var skip = state.clone();
                    skip.counts[elem.depth] = 0;
                    skip.elementIndex = elem.next;
                    queue.push(skip);
                }
            } else if (elem.isAltStart()) {
                // Wait at #ALT
                result.push(state);

                // Also explore skip if group min satisfied (fork for new seq)
                var endElem = this.findGroupEnd(elem);
                if (endElem) {
                    var count2 = state.counts[endElem.depth] || 0;
                    if (count2 >= endElem.min) {
                        var skip2 = state.clone();
                        skip2.counts[endElem.depth] = 0;
                        skip2.elementIndex = endElem.next;
                        queue.push(skip2);
                    }
                }
            } else if (elem.isGroupEnd()) {
                // Process #END (epsilon)
                // Greedy: repeat first, exit second
                // Reluctant: exit first, repeat second
                var count3 = (state.counts[elem.depth] || 0) + 1;

                if (count3 < elem.min) {
                    // Must repeat
                    var repeat = state.clone();
                    repeat.counts[elem.depth] = count3;
                    this.resetInnerCounts(repeat, elem.depth);
                    repeat.elementIndex = elem.jump;
                    queue.push(repeat);
                } else if (count3 >= elem.max) {
                    // Must exit
                    var exit = state.clone();
                    exit.counts[elem.depth] = 0;
                    exit.elementIndex = elem.next;
                    queue.push(exit);
                } else if (elem.reluctant) {
                    // Reluctant: exit first
                    var exit2 = state.clone();
                    exit2.counts[elem.depth] = 0;
                    exit2.elementIndex = elem.next;
                    queue.push(exit2);

                    // fork for second branch (new seq)
                    var repeat2 = state.clone();
                    repeat2.counts[elem.depth] = count3;
                    this.resetInnerCounts(repeat2, elem.depth);
                    repeat2.elementIndex = elem.jump;
                    queue.push(repeat2);
                } else {
                    // Greedy: repeat first
                    var repeat3 = state.clone();
                    repeat3.counts[elem.depth] = count3;
                    this.resetInnerCounts(repeat3, elem.depth);
                    repeat3.elementIndex = elem.jump;
                    queue.push(repeat3);

                    // fork for second branch (new seq)
                    var exit3 = state.clone();
                    exit3.counts[elem.depth] = 0;
                    exit3.elementIndex = elem.next;
                    queue.push(exit3);
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
        var merged = [];         // Array to preserve insertion order
        var mergedIndex = {};    // hash -> index in merged
        for (var i = 0; i < states.length; i++) {
            var state = states[i];
            var hash = state.hash();
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
        var idx = altElem.next;
        while (idx >= 0 && idx < this.pattern.elements.length) {
            var elem = this.pattern.elements[idx];
            if (elem.isGroupEnd()) return elem;
            idx = elem.next;
        }
        return null;
    }

    /**
     * Reset inner counts
     */
    resetInnerCounts(state, depth) {
        for (var d = depth + 1; d < state.counts.length; d++) {
            state.counts[d] = 0;
        }
    }

    /**
     * Filter out non-viable states
     * States at #ALT or VAR that can't progress AND can't exit
     */
    filterNonViableStates(states, trueVars) {
        var result = [];
        for (var i = 0; i < states.length; i++) {
            var state = states[i];
            if (state.elementIndex === -1) {
                result.push(state);
                continue;
            }

            var elem = this.pattern.elements[state.elementIndex];
            if (!elem) {
                result.push(state);
                continue;
            }

            if (elem.isAltStart()) {
                // Can any alternative match?
                var canMatch = this.canAltMatch(elem, trueVars);
                if (canMatch) {
                    result.push(state);
                    continue;
                }

                // Can we exit the group?
                var endElem = this.findGroupEnd(elem);
                if (endElem) {
                    var count = state.counts[endElem.depth] || 0;
                    if (count >= endElem.min) {
                        result.push(state);
                    }
                }
            } else if (elem.isVar()) {
                // Can we match this VAR?
                if (this.hasVarId(trueVars, elem.varId)) {
                    result.push(state);
                    continue;
                }

                // Can we skip this VAR?
                var count2 = state.counts[elem.depth] || 0;
                if (count2 >= elem.min) {
                    result.push(state);
                }
            } else {
                result.push(state);
            }
        }
        return result;
    }

    /**
     * Find consumable alternatives from an #ALT element (recursive for nested ALTs)
     */
    findConsumableAlternatives(state, altElem, trueVars, consumableStates) {
        var altIdx = altElem.next;
        while (altIdx >= 0 && altIdx < this.pattern.elements.length) {
            var elem = this.pattern.elements[altIdx];
            if (!elem) break;

            if (elem.isVar() && this.hasVarId(trueVars, elem.varId)) {
                var altState = state.clone();
                altState.elementIndex = altIdx;
                consumableStates.push(altState);
            } else if (elem.isAltStart()) {
                // Nested ALT - recurse into it
                this.findConsumableAlternatives(state, elem, trueVars, consumableStates);
            }
            altIdx = elem.jump;
        }
    }

    /**
     * Check if any alternative in a group can match the input (recursive for nested ALTs)
     */
    canAltMatch(altElem, trueVars) {
        var altIdx = altElem.next;
        while (altIdx >= 0 && altIdx < this.pattern.elements.length) {
            var elem = this.pattern.elements[altIdx];
            if (!elem) break;

            if (elem.isVar() && this.hasVarId(trueVars, elem.varId)) {
                return true;
            } else if (elem.isAltStart()) {
                // Nested ALT - recurse into it
                if (this.canAltMatch(elem, trueVars)) {
                    return true;
                }
            }
            altIdx = elem.jump;
        }
        return false;
    }

    /**
     * Context absorption
     */
    absorbContexts(log) {
        var absorptions = [];
        if (this.contexts.length <= 1) return absorptions;

        this.contexts.sort(function(a, b) { return a.matchStart - b.matchStart; });
        var absorbed = {};  // index -> true

        for (var i = 0; i < this.contexts.length; i++) {
            if (absorbed[i]) continue;
            var earlier = this.contexts[i];
            if (earlier.isCompleted) continue;

            for (var j = i + 1; j < this.contexts.length; j++) {
                if (absorbed[j]) continue;
                var later = this.contexts[j];
                if (later.isCompleted) continue;

                // Check if all later states can be absorbed by earlier states
                var canAbsorb = true;
                for (var li = 0; li < later.states.length; li++) {
                    var ls = later.states[li];
                    var found = false;
                    for (var ei = 0; ei < earlier.states.length; ei++) {
                        var es = earlier.states[ei];
                        if (es.elementIndex !== ls.elementIndex) continue;
                        var elem = this.pattern.elements[es.elementIndex];
                        if (!elem) {
                            found = true;
                            break;
                        }
                        var countsMatch = true;
                        if (elem.max === Infinity) {
                            for (var d = 0; d < es.counts.length; d++) {
                                if ((es.counts[d] || 0) < (ls.counts[d] || 0)) {
                                    countsMatch = false;
                                    break;
                                }
                            }
                        } else {
                            for (var d = 0; d < es.counts.length; d++) {
                                if ((es.counts[d] || 0) !== (ls.counts[d] || 0)) {
                                    countsMatch = false;
                                    break;
                                }
                            }
                        }
                        if (countsMatch) {
                            found = true;
                            break;
                        }
                    }
                    if (!found) {
                        canAbsorb = false;
                        break;
                    }
                }

                if (canAbsorb && later.states.length > 0) {
                    absorbed[j] = true;
                    var statesCopy = [];
                    for (var si = 0; si < later.states.length; si++) {
                        var s = later.states[si];
                        var countsCopy = [];
                        for (var ci = 0; ci < s.counts.length; ci++) countsCopy.push(s.counts[ci]);
                        var pathsCopy = [];
                        var matchedPaths = s.matchedPaths;
                        for (var pi = 0; pi < matchedPaths.length; pi++) {
                            var pCopy = [];
                            for (var pk = 0; pk < matchedPaths[pi].length; pk++) pCopy.push(matchedPaths[pi][pk]);
                            pathsCopy.push(pCopy);
                        }
                        statesCopy.push({
                            elementIndex: s.elementIndex,
                            counts: countsCopy,
                            matchedPaths: pathsCopy
                        });
                    }
                    absorptions.push({
                        absorbedId: later.id,
                        byId: earlier.id,
                        states: statesCopy
                    });
                    log('Context #' + later.id + ' absorbed by #' + earlier.id, 'warning');
                }
            }
        }

        var remaining = [];
        for (var i = 0; i < this.contexts.length; i++) {
            if (!absorbed[i]) remaining.push(this.contexts[i]);
        }
        this.contexts = remaining;
        return absorptions;
    }

    /**
     * Get valid start states for given input (for testing)
     * @param {string[]} trueVarNames - Array of variable names
     */
    getStartStates(trueVarNames) {
        var trueVars = this.toVarIds(trueVarNames);
        if (this.pattern.elements.length === 0) return [];
        var initCounts = [];
        for (var i = 0; i <= this.pattern.maxDepth; i++) initCounts.push(0);
        var initState = new MatchState(0, initCounts);
        var waitStates = this.expandToWaitPositions([initState]);

        var valid = [];
        for (var i = 0; i < waitStates.length; i++) {
            var state = waitStates[i];
            if (state.elementIndex === -1) continue;
            var elem = this.pattern.elements[state.elementIndex];
            if (!elem) continue;
            if (elem.isVar() && this.hasVarId(trueVars, elem.varId)) {
                valid.push(state);
            } else if (elem.isAltStart()) {
                var altIdx = elem.next;
                while (altIdx >= 0 && altIdx < this.pattern.elements.length) {
                    var altElem = this.pattern.elements[altIdx];
                    if (altElem && altElem.isVar() && this.hasVarId(trueVars, altElem.varId)) {
                        var altState = state.clone();
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
    window.SKIP_PAST_LAST = SKIP_PAST_LAST;
    window.SKIP_TO_NEXT = SKIP_TO_NEXT;
    window.OUTPUT_ONE_ROW = OUTPUT_ONE_ROW;
    window.OUTPUT_ALL_ROWS = OUTPUT_ALL_ROWS;
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
        NFAExecutor,
        SKIP_PAST_LAST,
        SKIP_TO_NEXT,
        OUTPUT_ONE_ROW,
        OUTPUT_ALL_ROWS
    };
}
