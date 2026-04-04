# DUMONT AGENT — Communication Layer
# SPARC Specification v2.2

## Specification · Pseudocode · Architecture · Refinement · Completion

**Project:** Dumont Agent Communication Layer
**Pattern:** ruvnet/Ruflo — Router → Capabilities → Memory → Learning Loop
**Constraint:** Copilot-first. Nothing sends without human approval until autonomy is earned.
**File limit:** All files under 500 lines. Split if exceeded.
**Security:** No hardcoded secrets. All credentials via environment variables.
**Refinements (v2.1):** Evaluator-optimizer pattern (Anthropic), edit memory/reflection (Andrew Ng), stage regression (dynamic planning).
**Stack (v2.2):** Bland AI (voice SDR + iMessage + SMS, client-facing), Resend (email, operator RFQs), Twilio (conference bridge, copilot), Deepgram (real-time transcription, replaces Whisper). Four providers, four adapters.

---

# PHASE 1: SPECIFICATION

## 1.1 Project Goal

Extend the Dumont Agent orchestrator with a communication nervous system: 5 inbound/outbound channels feeding a single pipeline, a voice pipeline with real-time transcription, and a confidence-gated response system where Dumont drafts everything but sends nothing until autonomy is earned per-template.

## 1.2 Functional Requirements

### FR-1: Message Normalization
Every communication channel produces a unified Message object. The orchestrator never knows which channel a message came from.

**Acceptance Criteria:**
- GIVEN an inbound email from Resend webhook, WHEN the email adapter processes it, THEN a Message is created with channel="email", direction="inbound", body containing the email text, from containing the sender address
- GIVEN an inbound SMS from Twilio webhook, WHEN the SMS adapter processes it, THEN a Message is created with the same schema shape as an email Message
- GIVEN a web form POST, WHEN the form adapter processes it, THEN a Message is created with channel="web_form" and structured fields mapped to body text
- GIVEN a WhatsApp message from Twilio/Meta webhook, WHEN the WhatsApp adapter processes it, THEN a Message is created with channel="whatsapp" including any media attachment URLs
- GIVEN a voice call transcript chunk from Whisper, WHEN the voice adapter processes it, THEN a Message is created with channel="voice" and the transcript as body

### FR-2: Message Routing
A MessageRouter receives every Message and routes it to the correct deal and pipeline stage.

**Acceptance Criteria:**
- GIVEN a Message from an unknown sender with no matching deal, WHEN the router processes it, THEN a new DealContext is created via intake.ts and the Message is linked via dealId
- GIVEN a Message from a known sender matching an active deal (by phone, email, or threadId), WHEN the router processes it, THEN the Message is appended to the existing deal's conversation
- GIVEN an operator email containing a price (e.g. "$28,000 all-in"), WHEN the router classifies it as intent="quote_response", THEN the deal advances to stage "quoted" and the price is parsed into the DealContext
- GIVEN a client message saying "let's do it" on an active deal at stage "presented", WHEN the router classifies it as intent="confirmation", THEN the deal advances to "confirmed" and closeDeal() is triggered
- GIVEN a Message that matches multiple active deals for the same contact, WHEN the router processes it, THEN it matches to the most recently updated deal

### FR-3: Channel Adapters (5 channels)
Each channel implements a ChannelAdapter interface with receive(), deliver(), and supportsRealtime().

**Acceptance Criteria:**
- Email adapter: receive() parses Resend webhook JSON. deliver() sends via Resend API with OSA HTML template. Thread matching uses In-Reply-To headers.
- SMS adapter: receive() parses Twilio webhook form data. deliver() sends via Twilio Messages API. Thread matching uses phone number.
- WhatsApp adapter: receive() parses Twilio/Meta webhook JSON. deliver() sends via Twilio/Meta API. Supports rich messages (images, documents). Respects 24-hour template window.
- Web form adapter: receive() parses POST body. deliver() is no-op (responses go via email/SMS). Creates new deal always.
- Voice adapter: receive() converts Whisper transcript chunks to Messages. deliver() is no-op (voice is human-driven). See FR-5 for full voice spec.

### FR-4: Respond Capability
Generates contextual reply drafts with confidence scoring. Does NOT decide — drafts.

**Acceptance Criteria:**
- GIVEN a qualified deal needing an operator outreach, WHEN respond() is called, THEN it produces a draft email/SMS with route, date, pax, aircraft preference, and a confidence score
- GIVEN a deal with an operator quote ready for client, WHEN respond() is called with intent="quote_delivery", THEN it produces a client-facing quote with all-in price, aircraft details, validity window, and confidence="never" (price always needs approval)
- GIVEN the same ContentIntent, WHEN formatted by the email adapter vs SMS adapter, THEN the email version is full HTML with OSA branding and the SMS version is under 320 characters
- GIVEN a response draft with confidence="high" for a template approved 10+ times with 0 edits, WHEN the autonomy gate evaluates it, THEN it auto-sends without human approval
- GIVEN a response draft with confidence="never" (contains a dollar amount to a client), WHEN the autonomy gate evaluates it, THEN it ALWAYS holds for human approval regardless of approval history

### FR-5: Voice Pipeline
Twilio conference bridge with Whisper real-time transcription. Dumont listens, never speaks.

**Acceptance Criteria:**
- GIVEN a broker taps "Call Operator" in Mission Control, WHEN the call initiates, THEN Twilio creates a 3-way conference: broker phone + operator phone + muted Dumont listener
- GIVEN an active call with audio streaming, WHEN Whisper processes the audio, THEN transcript chunks are emitted with speaker diarization (broker vs counterparty) and pushed to Mission Control via WebSocket within 500ms
- GIVEN a transcript chunk containing "twenty-eight thousand", WHEN the TranscriptProcessor parses it, THEN it detects entity {type: "price", value: "$28,000", raw: "twenty-eight thousand", speaker: "operator"}
- GIVEN a custom aviation vocabulary (ICAO codes, tail patterns, aircraft types), WHEN Whisper transcribes "november three hundred echo lima", THEN it produces "N300EL" (not gibberish)
- GIVEN call recording is enabled, WHEN the call ends, THEN the full recording is stored with a 90-day TTL and the transcript is permanently retained as structured data
- GIVEN applicable jurisdiction requires consent, WHEN the call connects, THEN a brief disclosure plays before the conversation begins

### FR-6: SDR Qualification
Dumont as automated SDR for inbound vetting.

**Acceptance Criteria:**
- GIVEN an inbound with route + date + pax + budget, WHEN the SDR classifies it, THEN classification="qualified_with_budget" and a deal is created with full context
- GIVEN an inbound with route + date + pax but no budget, WHEN the SDR classifies it, THEN classification="qualified_no_budget" and a budget-ask response is drafted
- GIVEN an inbound missing route or date or pax, WHEN the SDR classifies it, THEN classification="not_qualified" and a detail-request response is drafted
- GIVEN an inbound where budget < estimate floor, WHEN the SDR classifies it, THEN classification="budget_mismatch" and a tactful pricing-reality response is drafted
- GIVEN an auto-response template that has been approved 10+ times with 0 edits, WHEN shouldAutoSend() evaluates it, THEN it returns true and the response sends without human approval

### FR-7: Conversation Threading
All messages for a deal are unified in a single chronological thread regardless of channel.

**Acceptance Criteria:**
- GIVEN a client starts on WhatsApp then says "email me the quote", WHEN the quote is sent via email, THEN both the WhatsApp messages and the email appear in one conversation thread under one dealId
- GIVEN a deal with 5 messages across 3 channels, WHEN the conversation is rendered, THEN messages appear in chronological order with channel icons, direction arrows, and Dumont's parsed data overlay
- GIVEN every message in a conversation, WHEN metrics are computed, THEN touchpointCount, avgResponseTimeMs, and channelsUsed are accurate

### FR-8: Data Capture
Every interaction is structured, timestamped, trainable data.

**Acceptance Criteria:**
- GIVEN an outbound draft by Dumont that the broker edits before sending, WHEN the message is stored, THEN editDistance (word count changed) and originalDraft (Dumont's version) are both recorded
- GIVEN an operator response to an outreach, WHEN responseTimeMs is computed, THEN it equals the time between the outbound message's sentAt and the inbound message's receivedAt
- GIVEN 50 closed deals with call transcripts, WHEN the learning loop aggregates, THEN per-operator negotiation patterns, per-client conversion triggers, and per-route pricing intelligence are queryable from DealStore

### FR-9: Draft Evaluation (Evaluator-Optimizer Pattern)
Before any draft reaches the confidence gate, a second LLM pass evaluates it for tone, accuracy, and client-appropriateness. The generator drafts; the evaluator catches problems; the generator revises if needed. One extra LLM call per outbound draft. Source: Anthropic "Building Effective Agents" — evaluator-optimizer workflow.

**Acceptance Criteria:**
- GIVEN a draft generated by respond(), WHEN the evaluator reviews it, THEN it checks: tone matches broker's style, all claims are verifiable from DealContext, pricing is presented clearly, tone is appropriate for client type (EA vs principal vs first-timer)
- GIVEN an evaluator that finds zero issues, WHEN the evaluation completes, THEN the draft passes through unchanged to the confidence gate with wasRevised=false
- GIVEN an evaluator that finds issues (e.g. "draft claims aircraft has WiFi but DealContext has no amenity data"), WHEN revision is triggered, THEN the generator rewrites the draft incorporating the evaluator's feedback, and wasRevised=true is recorded
- GIVEN a draft that was revised, WHEN it reaches Mission Control for approval, THEN both the original and revised versions are visible so the broker can see what changed and why
- GIVEN the evaluator adds latency, WHEN measured end-to-end, THEN the evaluation + optional revision adds no more than 3 seconds to the draft generation time (use Haiku for evaluation, Sonnet for revision)

### FR-10: Edit Memory (Reflection Pattern)
Dumont learns the broker's voice by studying past corrections. When the broker edits a draft before sending, the original and edited versions are stored. On future drafts of the same type, the last N edited examples are included in the system prompt so Dumont converges on the broker's style. Source: Andrew Ng — reflection pattern applied to learning from human feedback.

**Acceptance Criteria:**
- GIVEN 5 previous follow-up email drafts that the broker edited before sending, WHEN respond() generates a new follow-up email, THEN the system prompt includes those 5 original→edited pairs as style examples
- GIVEN the broker has never edited a qualification SMS, WHEN respond() generates one, THEN no edit examples are included (cold start — no reflection data yet)
- GIVEN 20 stored edit patterns for operator RFQ emails, WHEN respond() generates a new one, THEN only the most recent 10 are included (capped to control token usage)
- GIVEN a draft type where the broker has approved 10+ times with zero edits (autonomy earned), WHEN respond() generates a new one, THEN edit memory is still included (autonomy doesn't disable learning — the examples reinforce the correct style)
- GIVEN the edit memory query, WHEN measured, THEN it adds no more than 50ms to the respond() call (it's a store query, not an LLM call)

## 1.3 Non-Functional Requirements

- **Latency:** Inbound message → deal created in under 5 seconds
- **Transcript latency:** Audio → transcript chunk in Mission Control in under 500ms
- **File size:** All source files under 500 lines
- **Security:** No credentials in code. All via env vars. PII handling per CCPA minimum.
- **Call recording:** 90-day retention on audio. Permanent retention on transcripts (structured data only).
- **Rate limits:** Email 50/hr, SMS 30/hr, WhatsApp 30/hr per channel config

## 1.4 Edge Cases

| Edge Case | Expected Behavior |
|-----------|------------------|
| Same client emails AND texts about the same trip | Router matches both to the same deal via contact identifier |
| Message arrives for a closed deal | Router creates a new deal, links to client profile, notes "returning client" |
| Whisper misidentifies speaker (says broker said the price when operator did) | TranscriptProcessor flags low-confidence chunks; broker can correct in Mission Control |
| Operator replies to a 3-day-old email thread about a different deal | Router uses recency + content similarity; if ambiguous, flags for human matching |
| WhatsApp 24-hour template window expired | Adapter uses pre-approved WhatsApp template; if no template fits, flags for human to initiate |
| Two operators respond to same deal (shouldn't happen — we only call one) | Router links both to deal, flags second response as unexpected, human reviews |
| Network failure during Twilio stream | Voice adapter retries stream connection; if failed, falls back to post-call recording transcription |
| Client sends voice note via WhatsApp | WhatsApp adapter extracts audio, runs through Whisper, converts to text Message |
| Autonomy rule says auto-send but rate limit exceeded | Rate limiter blocks send, queues for next window, notifies broker |
| Draft approval timeout (broker doesn't approve within 30 min) | Timer nudges broker in Mission Control; after 1 hour, escalates to amber alert |
| Evaluator flags a problem but the revision makes it worse | Broker sees both original + revision + evaluator notes; can pick either or rewrite |
| Edit memory has conflicting style examples (broker changed style over time) | Most recent 10 edits win — older patterns are naturally displaced |
| Client says "that's too expensive, what about a smaller plane?" | Stage regression: presented → estimated with updated aircraft class preference |
| Operator quote expires while waiting for client approval | Stage regression: quoted → sourced, re-source same or different operator |
| Client rejects operator specifically ("not them, anyone else") | Stage regression: presented → sourced with rejected operator excluded |

---

# PHASE 2: PSEUDOCODE

## 2.1 MessageRouter

```
FUNCTION routeMessage(message: Message):
    
    // ── Step 1: Thread Matching ──
    deal = NULL
    
    // Try exact thread match (email In-Reply-To)
    IF message.responseToId:
        deal = findDealByMessageId(message.responseToId)
    
    // Try contact match (phone or email)
    IF NOT deal:
        contact = message.from
        activeDeal = findActiveDealByContact(contact)
        IF activeDeal:
            deal = activeDeal
    
    // Try threadId match (email thread, WhatsApp conversation)
    IF NOT deal AND message.threadId:
        deal = findDealByThreadId(message.threadId)
    
    // No match → new deal
    IF NOT deal:
        intakeResult = AWAIT intake(message.body)
        deal = createDealFromIntake(intakeResult)
        deal.conversation = new Conversation(deal.id)
    
    // ── Step 2: Append to conversation ──
    deal.conversation.addMessage(message)
    message.dealId = deal.id
    
    // ── Step 3: Extract new data ──
    // Run extractors on EVERY inbound, not just first
    newData = runExtractors(message.body)
    IF newData.pax AND newData.pax != deal.trip.pax:
        deal.trip.pax = newData.pax  // client updated pax count
    IF newData.budget AND NOT deal.client.budget:
        deal.client.budget = newData.budget  // budget provided in follow-up
    // ... same for date, route, aircraft
    
    // ── Step 4: Classify intent ──
    intent = classifyIntent(message, deal)
    
    // ── Step 5: Stage advancement ──
    SWITCH intent:
        CASE "quote_response":
            IF isFromOperator(message, deal):
                price = extractPrice(message.body)
                IF price:
                    deal.quote.operatorPrice = price
                    advanceStage(deal, "quoted")
                    runGuardian(deal, "quoted")
                    
        CASE "confirmation":
            IF isFromClient(message, deal):
                closeDeal(deal, { result: "closed" })
                
        CASE "decline":
            IF isFromClient(message, deal):
                closeDeal(deal, { result: "client_declined" })
            IF isFromOperator(message, deal):
                activateBackup(deal)
                
        CASE "negotiation":
            // Never auto-handle negotiation
            flagForHuman(deal, "negotiation_detected")
            
        CASE "info_request":
            // Draft response, confidence based on question type
            
    // ── Step 6: Generate response ──
    IF shouldRespond(intent, deal):
        draft = AWAIT respond(deal, message, intent)
        applyConfidenceGate(draft, deal)
    
    RETURN { deal, intent, draft }
END FUNCTION
```

## 2.2 Confidence Gate

```
FUNCTION applyConfidenceGate(draft: Message, deal: DealContext):
    
    level = draft.confidenceLevel
    channel = draft.channel
    intent = draft.intent
    recipientType = getRecipientType(draft, deal)
    
    // Load autonomy rules for this channel + intent + recipient
    rule = loadAutonomyRule(channel, intent, recipientType)
    
    // NEVER auto-send list (hard-coded, not configurable)
    IF containsDollarAmount(draft.body) AND recipientType == "client":
        HOLD_FOR_APPROVAL(draft)
        RETURN
    IF intent IN ["negotiation", "availability_commitment", "safety_claim"]:
        HOLD_FOR_APPROVAL(draft)
        RETURN
    IF isFirstContactWithOperator(draft.to, deal):
        HOLD_FOR_APPROVAL(draft)
        RETURN
    
    // Check earned autonomy
    IF rule.autoSendEnabled AND rule.currentApprovals >= rule.autoSendAfter:
        DELIVER_IMMEDIATELY(draft)
        RETURN
    
    // Medium confidence: delayed send with intercept window
    IF level == "medium":
        HOLD_WITH_COUNTDOWN(draft, rule.maxDelaySeconds)
        RETURN
    
    // Everything else: hold for approval
    HOLD_FOR_APPROVAL(draft)
    
END FUNCTION
```

## 2.3 Voice Call Flow

```
FUNCTION initiateCall(dealId: string, targetPhone: string, targetRole: string):
    
    deal = getDeal(dealId)
    
    // Generate call brief from DealContext
    brief = generateCallBrief(deal, targetRole)
    // brief contains: talking points, last deal history,
    // estimate range, budget ceiling, negotiation guide
    
    // Create Twilio conference
    conference = twilio.createConference({
        friendlyName: deal.id,
        recordingEnabled: TRUE,
        recordingChannels: "dual"  // separate channels per speaker
    })
    
    // Add broker's phone
    twilio.addParticipant(conference, brokerPhone, {
        label: "broker",
        muted: FALSE
    })
    
    // Add target (operator or client)
    twilio.addParticipant(conference, targetPhone, {
        label: targetRole,
        muted: FALSE,
        // Play consent disclosure before connecting
        announceUrl: "/audio/recording-disclosure.mp3"
    })
    
    // Start audio stream to Whisper
    stream = twilio.startStream(conference, {
        url: WHISPER_WEBSOCKET_URL,
        tracks: "both"  // both speakers
    })
    
    // Create Call record
    call = createCall({
        dealId: deal.id,
        direction: "outbound_to_" + targetRole,
        participants: [
            { name: brokerName, role: "broker", phone: brokerPhone },
            { name: targetName, role: targetRole, phone: targetPhone }
        ],
        startedAt: NOW(),
        callBrief: brief
    })
    
    // Push to Mission Control
    emit("call_started", { dealId, call, brief })
    
    // Begin transcript processing loop
    WHILE stream.isActive:
        chunk = AWAIT stream.nextChunk()
        
        // Whisper transcription
        transcript = whisper.transcribe(chunk, {
            vocabulary: AVIATION_VOCABULARY,
            diarization: TRUE
        })
        
        // Process for entities
        entities = transcriptProcessor.processChunk(transcript, call.transcript)
        
        // Push to Mission Control in real-time
        emit("transcript_chunk", { dealId, chunk: transcript })
        FOR EACH entity IN entities:
            emit("entity_detected", { dealId, entity })
        
        // Append to call record
        call.transcript.push(transcript)
        call.detectedEntities.push(...entities)
    
    // Call ended
    call.endedAt = NOW()
    call.durationSec = (call.endedAt - call.startedAt) / 1000
    
    // Generate summary
    call.summary = AWAIT transcriptProcessor.generateSummary(call)
    
    // Save
    saveCall(call)
    emit("call_ended", { dealId, summary: call.summary })
    
END FUNCTION
```

## 2.4 Autonomy Graduation

```
FUNCTION onDraftApproved(draft: Message, editDistance: number):
    
    rule = loadAutonomyRule(draft.channel, draft.intent, recipientType)
    
    IF editDistance == 0:
        rule.currentApprovals += 1
        
        IF rule.currentApprovals >= rule.autoSendAfter:
            rule.autoSendEnabled = TRUE
            emit("autonomy_graduated", {
                template: draft.intent,
                channel: draft.channel,
                approvalCount: rule.currentApprovals
            })
    ELSE:
        // Edited — reset counter (Dumont hasn't earned trust yet)
        rule.currentApprovals = 0
        rule.autoSendEnabled = FALSE
        
        // Store the edit for Dumont to learn from
        storeEditPattern({
            originalDraft: draft.originalDraft,
            editedVersion: draft.body,
            editDistance: editDistance,
            intent: draft.intent,
            channel: draft.channel
        })
    
    saveAutonomyRule(rule)
    
END FUNCTION
```

## 2.5 Draft Evaluator (Evaluator-Optimizer Pattern)

```
FUNCTION evaluateDraft(draft: Message, deal: DealContext):
    
    // Load edit memory for context on broker's style
    editHistory = getEditHistory(draft.intent, draft.channel)
    
    // Evaluator pass — cheap model (Haiku), focused prompt
    evaluation = LLM_CALL({
        model: "haiku",
        system: "You are a charter aviation communications reviewer.
                 Evaluate this draft for:
                 1. TONE: Does it match the broker's style? 
                    (See edit examples below for reference)
                 2. ACCURACY: Every claim must be verifiable from 
                    the deal context provided. Flag any claim that 
                    isn't backed by data (e.g. 'WiFi available' when 
                    no amenity data exists).
                 3. CLARITY: Is pricing presented unambiguously? 
                    Is the call-to-action clear?
                 4. APPROPRIATENESS: Is the tone right for this 
                    client type (EA vs principal vs first-timer)?
                 
                 Return JSON: { issues: string[], pass: boolean }
                 If no issues, return { issues: [], pass: true }",
        user: {
            draft: draft.body,
            dealContext: summarizeDealForEval(deal),
            clientType: deal.client.type,
            recipientType: getRecipientType(draft, deal),
            editExamples: editHistory.slice(0, 5),
            conversationSoFar: deal.conversation.messages.slice(-5)
        }
    })
    
    IF evaluation.pass:
        RETURN { 
            draft: draft.body, 
            wasRevised: false, 
            issues: [] 
        }
    
    // Revision pass — standard model (Sonnet), with feedback
    revisedBody = LLM_CALL({
        model: "sonnet",
        system: "Revise this draft based on the evaluator's feedback.
                 Keep the same intent and all factual content.
                 Only fix the issues identified.",
        user: {
            original: draft.body,
            issues: evaluation.issues,
            dealContext: summarizeDealForEval(deal),
            editExamples: editHistory.slice(0, 5)
        }
    })
    
    RETURN { 
        draft: revisedBody, 
        wasRevised: true, 
        issues: evaluation.issues,
        originalBeforeRevision: draft.body
    }

END FUNCTION
```

## 2.6 Edit Memory (Reflection Pattern)

```
FUNCTION getEditHistory(intent: string, channel: string):
    
    // Query MessageStore for drafts that were edited by broker
    editedDrafts = MessageStore.query({
        draftedBy: "dumont",
        direction: "outbound",
        intent: intent,
        channel: channel,
        editDistance: { gt: 0 },   // only drafts that were changed
        limit: 10,                  // cap for token budget
        sort: "sentAt DESC"         // most recent edits first
    })
    
    // Transform into learning examples
    patterns = editedDrafts.map(msg => ({
        dumont_wrote: msg.originalDraft,
        broker_changed_to: msg.body,
        words_changed: msg.editDistance,
        context: msg.intent + " / " + msg.channel
    }))
    
    RETURN patterns

END FUNCTION


FUNCTION buildRespondSystemPrompt(deal, intent, channel):
    
    basePrompt = loadBasePrompt(intent, channel)
    
    // Inject edit memory if available
    editHistory = getEditHistory(intent, channel)
    
    IF editHistory.length > 0:
        basePrompt += "\n\n--- STYLE LEARNING ---\n"
        basePrompt += "Below are your recent drafts of this type that "
        basePrompt += "the broker edited before sending. Study the "
        basePrompt += "differences and write in the broker's voice.\n\n"
        
        FOR EACH example IN editHistory:
            basePrompt += "YOUR DRAFT: " + example.dumont_wrote + "\n"
            basePrompt += "BROKER SENT: " + example.broker_changed_to + "\n"
            basePrompt += "---\n"
    
    RETURN basePrompt

END FUNCTION
```

## 2.7 Stage Regression (Dynamic Planning)

```
// Allowed backward transitions in the pipeline.
// Forward transitions are in VALID_TRANSITIONS (existing).
// Regressions handle real-world deal flow changes.

ALLOWED_REGRESSIONS = {
    presented → estimated:   
        // Client wants different aircraft class or cheaper option
        // Trigger: client says "what about a lighter jet?"
        // Action: clear sourcing + quote data, re-estimate with new class
        
    presented → sourced:     
        // Client rejects specific operator
        // Trigger: client says "not them" or "anyone else"
        // Action: exclude rejected operator, re-run sourcing
        
    quoted → sourced:        
        // Quote expired, need fresh operator
        // Trigger: quote validUntil has passed
        // Action: clear quote data, re-source (may pick same operator)
        
    sourced → estimated:     
        // Operator not available, changes aircraft scope
        // Trigger: operator says "don't have that type, but have X"
        // Action: update aircraft preference, re-estimate
}

NOT ALLOWED:
    // Any regression past intake → start a new deal instead
    // closed → anything → deal is final, start new deal
    // failed → anything → deal is final, start new deal

FUNCTION regressStage(deal: DealContext, to: DealStage, reason: string):
    
    from = deal.stage
    
    IF NOT isAllowedRegression(from, to):
        THROW PipelineError("Cannot regress from " + from + " to " + to)
    
    // Log the regression with reason
    deal.stageHistory.push({
        stage: "regression:" + from + "→" + to,
        enteredAt: NOW(),
        reason: reason
    })
    
    // Clear data that's no longer valid
    SWITCH to:
        CASE "estimated":
            deal.sourcing = EMPTY_SOURCING
            deal.quote = EMPTY_QUOTE
            deal.presentation = null
            
        CASE "sourced":
            deal.quote = EMPTY_QUOTE
            deal.presentation = null
    
    // Advance to the target stage
    deal.stage = to
    deal.updatedAt = NOW()
    
    emit("stage_regressed", { dealId: deal.id, from, to, reason })

END FUNCTION
```

---

# PHASE 3: ARCHITECTURE

## 3.1 File Structure

```
src/
├── schemas/                          ← Zod schemas (shared foundation)
│   ├── message.ts                    ← Message + enums (< 200 lines)
│   ├── conversation.ts              ← Conversation schema (< 100 lines)
│   ├── call.ts                       ← Call + TranscriptChunk (< 200 lines)
│   ├── channel-config.ts            ← ChannelConfig + AutonomyRule (< 150 lines)
│   └── index.ts                      ← barrel exports
│
├── channels/                         ← Channel adapters (dumb pipes)
│   ├── adapter.ts                    ← ChannelAdapter interface (< 50 lines)
│   ├── bland-ai.ts                   ← Bland AI: voice SDR + iMessage + SMS (< 250 lines)
│   ├── email.ts                      ← Resend: operator RFQs + formal quotes (< 200 lines)
│   ├── web-form.ts                   ← POST endpoint: website quote form (< 100 lines)
│   ├── voice.ts                      ← Twilio conference + Deepgram stream: copilot (< 300 lines)
│   └── index.ts
│
├── router/                           ← Message routing (the brain)
│   ├── message-router.ts            ← Route inbound to pipeline (< 300 lines)
│   ├── thread-matcher.ts            ← Match messages to deals (< 200 lines)
│   ├── intent-classifier.ts         ← Classify message intent (< 200 lines)
│   └── confidence-gate.ts           ← Autonomy + confidence logic (< 200 lines)
│
├── capabilities/                     ← Existing + new
│   ├── intake.ts                     ← EXISTING (unchanged)
│   ├── guardian.ts                   ← EXISTING (unchanged)
│   ├── quote.ts                      ← EXISTING (unchanged)
│   ├── sourcing.ts                   ← EXISTING (unchanged)
│   ├── scenario.ts                   ← EXISTING (unchanged)
│   ├── respond.ts                    ← NEW: contextual reply generation (< 300 lines)
│   ├── draft-evaluator.ts           ← NEW: evaluator-optimizer pattern (< 200 lines)
│   ├── sdr.ts                        ← NEW: SDR qualification (< 200 lines)
│   └── transcript-processor.ts      ← NEW: voice entity extraction (< 300 lines)
│
├── integrations/                     ← External service clients
│   ├── aviapages.ts                  ← EXISTING
│   ├── bland-ai.ts                   ← NEW: voice + iMessage + SMS client (< 200 lines)
│   ├── resend.ts                     ← NEW: email send/receive (< 150 lines)
│   ├── twilio.ts                     ← NEW: conference bridge for copilot (< 200 lines)
│   └── deepgram.ts                   ← NEW: real-time streaming transcription (< 200 lines)
│
├── memory/                           ← Data stores
│   ├── deal-store.ts                 ← EXISTING
│   ├── message-store.ts             ← NEW: message persistence (< 200 lines)
│   ├── call-store.ts                ← NEW: call + transcript persistence (< 150 lines)
│   ├── autonomy-store.ts           ← NEW: per-template approval tracking (< 150 lines)
│   └── edit-memory.ts              ← NEW: broker edit patterns for reflection (< 150 lines)
│
├── templates/                        ← Response templates
│   ├── email/
│   │   ├── operator-rfq.html        ← operator quote request
│   │   ├── client-quote.html        ← client quote delivery
│   │   ├── follow-up.html           ← follow-up nudge
│   │   └── confirmation.html        ← booking confirmation
│   └── sms/
│       ├── operator-rfq.txt
│       ├── client-quote.txt
│       └── follow-up.txt
│
└── dashboard/src/components/         ← Mission Control extensions
    ├── ConversationThread.tsx        ← unified deal conversation view
    ├── DraftApproval.tsx             ← edit/approve/send drafts
    ├── CallAssist.tsx                ← live call panel
    ├── InboxFeed.tsx                 ← all inbound messages
    ├── SDRQueue.tsx                  ← qualification pipeline
    └── AutonomyDashboard.tsx         ← per-template autonomy tracking
```

## 3.2 Data Flow

```
INBOUND FLOW:
  Platform webhook/event
    → ChannelAdapter.receive()           [normalize to Message]
    → MessageStore.save()                [persist immediately]
    → MessageRouter.route()              [match deal, classify, advance]
      → ThreadMatcher.match()            [find or create deal]
      → IntentClassifier.classify()      [what does this message mean?]
      → Orchestrator pipeline             [existing: intake → guardian → etc]
      → Respond.draft()                  [generate reply + edit memory]
      → DraftEvaluator.evaluate()        [second LLM: tone/accuracy check]
      → ConfidenceGate.evaluate()        [auto-send or hold]
    → Dashboard WebSocket emit           [real-time UI update]

OUTBOUND FLOW:
  Respond.draft() produces Message (with edit memory in system prompt)
    → DraftEvaluator.evaluate()          [catch problems before human sees]
    → ConfidenceGate.evaluate()
      → AUTO: ChannelAdapter.deliver()   [send immediately]
      → DELAYED: hold N seconds          [broker can intercept]
      → HOLD: show in Mission Control    [broker must approve]
    → On approval:
      → ChannelAdapter.deliver()         [send via platform API]
      → MessageStore.save()              [persist with approval metadata]
      → AutonomyStore.recordApproval()   [track edit distance]
      → EditMemory.store()               [if edited, save original→edited pair]
      → Dashboard WebSocket emit         [update UI]

VOICE FLOW:
  Broker taps [Call]
    → Twilio conference bridge created   [3-way: broker + target + Dumont]
    → Audio stream → Whisper             [real-time transcription]
    → TranscriptProcessor                [entity extraction per chunk]
    → Dashboard WebSocket emit           [live transcript + detections]
    → On call end:
      → CallStore.save()                 [full transcript + entities]
      → MessageStore.save()             [call as a Message in conversation]
      → TranscriptProcessor.summary()   [post-call summary]
```

## 3.3 Security by Design

| Component | Security Consideration |
|-----------|----------------------|
| ChannelAdapter | All API keys via env vars. Never logged. Never in error messages. |
| MessageStore | PII fields (name, email, phone) marked. Queryable for CCPA deletion requests. |
| CallStore | Audio recordings encrypted at rest. 90-day TTL enforced by automated cleanup. Transcripts retained permanently but audio deleted. |
| Resend integration | Webhook signature verification on all inbound. Reject unsigned payloads. |
| Twilio integration | Request signature validation. Account SID + Auth Token via env vars. |
| Whisper integration | Audio sent over TLS. No audio retained by Whisper API after processing. |
| ConfidenceGate | "NEVER auto-send" list is hard-coded, not configurable. Cannot be overridden by autonomy rules. |
| DraftApproval | Edit history is append-only. Cannot be deleted. Audit trail for every outbound. |
| Voice consent | Per-jurisdiction disclosure. Default: always disclose. Can be disabled only by explicit config per region. |

## 3.4 WebSocket Events

```typescript
type DashboardEvent =
  | { type: "deal_created"; deal: DealContext }
  | { type: "deal_updated"; dealId: string; changes: Partial<DealContext> }
  | { type: "stage_advanced"; dealId: string; from: string; to: string }
  | { type: "message_received"; message: Message }
  | { type: "draft_ready"; dealId: string; draft: Message; confidence: number }
  | { type: "draft_approved"; dealId: string; messageId: string }
  | { type: "draft_sent"; dealId: string; messageId: string }
  | { type: "call_started"; dealId: string; call: Call }
  | { type: "transcript_chunk"; dealId: string; chunk: TranscriptChunk }
  | { type: "entity_detected"; dealId: string; entity: DetectedEntity }
  | { type: "call_ended"; dealId: string; summary: string }
  | { type: "guardian_alert"; dealId: string; pass: GuardianPass }
  | { type: "timer_alert"; dealId: string; level: TimerAlertLevel }
  | { type: "autonomy_graduated"; template: string; channel: string }
```

---

# PHASE 4: REFINEMENT (Build Sequence)

TDD for each sprint. Tests first, then implementation, then refactor.

## Sprint 1: Schemas + Router + Thread Matcher

**Files:** `schemas/message.ts`, `schemas/conversation.ts`, `schemas/call.ts`, `schemas/channel-config.ts`, `channels/adapter.ts`, `router/message-router.ts`, `router/thread-matcher.ts`

**Tests first:**
- New deal creation from unknown sender
- Thread match by email In-Reply-To
- Thread match by phone number
- Thread match by WhatsApp conversation SID
- Most-recent-deal match when multiple active deals for same contact
- Intent classification: quote_response, confirmation, decline, negotiation
- Stage advancement on operator quote detection
- Deal close on client confirmation
- Extractor re-run on follow-up messages (pax update, budget provided)
- Edge: message for closed deal creates new deal

**Claude Code prompt:**
```
Read specs/comms/communication-layer.md Phase 1 (FR-1, FR-2, FR-7) 
and Phase 2 (section 2.1). Create Zod schemas in src/schemas/ for 
Message, Conversation, Call, TranscriptChunk, and ChannelConfig per 
the spec. Create the ChannelAdapter interface in src/channels/adapter.ts. 
Implement MessageRouter in src/router/message-router.ts and 
ThreadMatcher in src/router/thread-matcher.ts. Router must: 
1) match inbound to existing deals by responseToId, phone, email, 
or threadId (most recent deal wins ties), 2) create new deals via 
existing intake.ts for unmatched messages, 3) run extractors on 
EVERY inbound message to capture updates, 4) classify intent 
(quote_response, confirmation, decline, negotiation, info_request), 
5) advance deal stage on operator quote or client confirmation. 
Write tests FIRST per the acceptance criteria in the spec. 
All files under 500 lines.
```

## Sprint 2: Bland AI Adapter (voice SDR + iMessage + SMS)

**Files:** `channels/bland-ai.ts`, `integrations/bland-ai.ts`

**Tests first:**
- Parse Bland AI voice call webhook payload into Message
- Parse Bland AI SMS/iMessage webhook payload into Message
- Extract structured analysis fields (departure, arrival, date, pax, budget)
- Thread matching by phone number across voice and text
- Bland AI user memory context carried between interactions
- Webhook signature verification
- Edge: voice call with no structured data extracted (freeform conversation)
- Edge: iMessage fallback to SMS for Android recipients

**Claude Code prompt:**
```
Read specs/comms/communication-layer.md Phase 1 and Phase 3.
Implement the Bland AI ChannelAdapter at src/channels/bland-ai.ts.
This is the unified client-facing channel — voice SDR calls, 
iMessage, and SMS all come through Bland AI webhooks.

receive() parses Bland AI webhook payloads into Message schema.
Voice webhooks include analysis_schema with structured fields 
(departure, arrival, date, pax, budget, client_name, phone).
SMS/iMessage webhooks include message text and phone number.
Both map to the same Message schema with channel="bland_voice" 
or channel="bland_text".

deliver() sends outbound iMessage/SMS via Bland AI send API.
Blue bubble iMessage with automatic SMS fallback.

Create src/integrations/bland-ai.ts with injectable fetch.
Webhook signature verification on all inbound.
Write tests FIRST. All files under 500 lines.
```

## Sprint 3: Email Adapter (Resend) + Web Form

**Files:** `channels/email.ts`, `channels/web-form.ts`, `integrations/resend.ts`, `templates/email/*.html`, `memory/message-store.ts`

**Tests first:**
- Parse Resend webhook payload into Message
- Extract In-Reply-To and References headers for threading
- Send outbound via Resend with OSA HTML template
- Template rendering with deal data interpolation
- Webhook signature verification (reject unsigned)
- Web form POST body parsed into Message
- Web form creates new deal always
- Edge: malformed webhook payload

**Claude Code prompt:**
```
Read specs/comms/communication-layer.md Phase 1 (FR-3 email) and 
Phase 3 (section 3.3 security). Implement the email ChannelAdapter 
at src/channels/email.ts using Resend API. Create src/integrations/resend.ts 
with injectable fetch. Implement web form adapter at src/channels/web-form.ts
(POST endpoint, inbound only, creates new deal). Implement MessageStore 
at src/memory/message-store.ts (JSON-backed, same pattern as DealStore). 
Create 3 email templates: operator-rfq, client-quote, follow-up. 
receive() must parse Resend webhook JSON, verify signature, extract 
threading headers. deliver() must send via Resend with HTML template 
+ deal data interpolation. Write tests first. All files under 500 lines.
```

> **Priority note (YC validation):** Voice (Sprint 4) is the highest-impact 
> channel — 76% of charter bookings start with phone calls. If time-constrained 
> after Sprint 1, skip to Sprint 4 before Sprint 3.

## Sprint 4: Voice Copilot Pipeline (Twilio + Deepgram)

**Files:** `channels/voice.ts`, `integrations/twilio.ts`, `integrations/deepgram.ts`, `capabilities/transcript-processor.ts`, `memory/call-store.ts`

**Tests first:**
- Conference bridge creation with 3 participants (broker + operator + muted Dumont)
- Audio stream routing to Deepgram WebSocket
- Transcript chunk parsing with speaker diarization labels
- Entity detection: prices, aircraft types, tail numbers, availability signals
- Custom vocabulary (ICAO codes, tail patterns, pricing language)
- Post-call summary generation
- CallStore persistence with transcript + entities
- Edge: stream reconnection on network failure
- Edge: low-confidence speaker ID flagged

**Claude Code prompt:**
```
Read specs/comms/communication-layer.md Phase 1 (FR-5) and Phase 2 
(section 2.3). Implement the voice ChannelAdapter at src/channels/voice.ts 
with Twilio conference bridge (3-way call, muted Dumont listener). 
Create src/integrations/twilio.ts for conference bridge management.
Create src/integrations/deepgram.ts for real-time WebSocket streaming 
transcription with custom aviation vocabulary (ICAO codes, tail 
patterns N+chars, aircraft types, pricing language "twenty-eight 
thousand" → $28,000). Deepgram Nova-2 with streaming diarization.
Build TranscriptProcessor at src/capabilities/transcript-processor.ts 
that runs intake extractors on accumulated transcript text and detects 
entities: prices, aircraft, tails, availability signals, negotiation 
signals per the entity table in the spec. Create CallStore at 
src/memory/call-store.ts. Use injectable Twilio/Deepgram clients 
for testing. Write tests first. All files under 500 lines.
```

## Sprint 5: Respond + Evaluator + Edit Memory + SDR + Confidence Gate

**Files:** `capabilities/respond.ts`, `capabilities/draft-evaluator.ts`, `capabilities/sdr.ts`, `router/intent-classifier.ts`, `router/confidence-gate.ts`, `memory/autonomy-store.ts`, `memory/edit-memory.ts`

**Tests first:**
- Response generation for each ContentIntent type
- Confidence scoring per intent type
- SDR classification (4 paths: qualified, no-budget, not-qualified, budget-mismatch)
- Autonomy graduation after 10 approvals with 0 edits
- Autonomy reset on any edit
- "NEVER auto-send" enforcement (prices, commitments, first-operator-contact)
- Edge: graduated autonomy revoked manually
- Edge: rate limit blocks auto-send
- Draft evaluator catches unverifiable claim (mentions WiFi when no amenity data)
- Draft evaluator passes clean draft unchanged (wasRevised=false)
- Draft evaluator triggers revision, revised draft fixes flagged issues
- Edit memory returns empty array on cold start (no previous edits)
- Edit memory returns last 10 edits sorted by recency
- Edit memory correctly filters by intent + channel combination
- Respond system prompt includes edit examples when available
- Respond system prompt omits edit section when no history exists

**Claude Code prompt:**
```
Read specs/comms/communication-layer.md Phase 1 (FR-4, FR-6, FR-9, 
FR-10) and Phase 2 (sections 2.2, 2.5, 2.6). 

Implement respond.ts: generates contextual reply drafts using Claude 
Sonnet. System prompt built by buildRespondSystemPrompt() which 
injects edit memory (broker's past corrections) when available. 
Outputs ContentIntent + draftText + confidence score.

Implement draft-evaluator.ts: takes a draft Message + DealContext, 
runs a Haiku evaluation pass checking tone/accuracy/clarity/
appropriateness. If issues found, runs a Sonnet revision pass. 
Returns { draft, wasRevised, issues, originalBeforeRevision }.

Implement edit-memory.ts in memory/: queries MessageStore for 
outbound drafts by Dumont where editDistance > 0, filtered by 
intent + channel, sorted by sentAt DESC, limited to 10. Returns 
array of { dumont_wrote, broker_changed_to, words_changed }.

Implement sdr.ts: classifies inbound as qualified_with_budget, 
qualified_no_budget, not_qualified, or budget_mismatch using 
existing intake extractors.

Implement confidence-gate.ts per section 2.2: NEVER auto-send 
list is hard-coded. Autonomy earned per-template per-channel 
per-recipient after 10 approvals with 0 edits.

Pipeline order: respond() → evaluateDraft() → confidenceGate().

Write tests FIRST. Use injectable LLM calls for testing. 
All files under 500 lines.
```

## Sprint 6: Mission Control Extensions

**Files:** 6 new dashboard components + `hooks/useWebSocket.ts`

**Tests:** Component rendering tests, WebSocket event handling

## Sprint 7: Integration Testing + Stage Regression

**Files:** `tests/integration/`, update `orchestrator/stage-transitions.ts`

**Tests:**
- End-to-end: email in → deal created → operator called → quote parsed → client quote sent → confirmation → closed → learning loop
- Stage regression: presented → estimated when client requests cheaper aircraft
- Stage regression: presented → sourced when client rejects operator
- Stage regression: quoted → sourced when quote expires
- Stage regression: blocks regression past intake (must start new deal)
- Stage regression: blocks regression from closed/failed

**Claude Code prompt:**
```
Read specs/comms/communication-layer.md Phase 2 (section 2.7 Stage 
Regression). Update src/orchestrator/stage-transitions.ts to add 
ALLOWED_REGRESSIONS alongside existing VALID_TRANSITIONS. Implement 
regressStage() that: validates the regression is allowed, logs it 
to stageHistory with reason, clears invalidated data (sourcing + 
quote when regressing to estimated, quote + presentation when 
regressing to sourced), emits stage_regressed event.

Also implement web form adapter and full integration tests.
Write tests FIRST. All files under 500 lines.
```

---

# PHASE 5: COMPLETION

## 5.1 Deployment Checklist

- [ ] All files under 500 lines
- [ ] Zero hardcoded credentials — all via env vars
- [ ] Resend webhook signature verification enabled
- [ ] Twilio request signature validation enabled
- [ ] Call recording consent disclosure configured per jurisdiction
- [ ] WhatsApp message templates pre-approved in Meta Business Manager
- [ ] Rate limits configured per channel (email 50/hr, SMS 30/hr, WhatsApp 30/hr)
- [ ] Audio recording 90-day TTL cleanup job configured
- [ ] PII fields documented for CCPA deletion capability
- [ ] "NEVER auto-send" list verified: dollar amounts, availability, safety, payment, negotiation
- [ ] Autonomy rules default to autoSendAfter=10, autoSendEnabled=false
- [ ] Dashboard WebSocket connection with reconnection logic
- [ ] Draft evaluator running Haiku (evaluation) + Sonnet (revision) — verify model config
- [ ] Edit memory query returns in under 50ms (index on intent + channel + editDistance)
- [ ] Stage regression clears correct data sections (test each regression path)
- [ ] All tests passing (unit + integration)
- [ ] TypeScript strict mode, zero type errors

## 5.2 Environment Variables Required

```
# Bland AI (Voice SDR + iMessage + SMS — client-facing)
BLAND_API_KEY=
BLAND_PHONE_NUMBER=
BLAND_WEBHOOK_SECRET=

# Resend (Email — operator RFQs + formal quotes)
RESEND_API_KEY=
RESEND_WEBHOOK_SECRET=
RESEND_FROM_ADDRESS=charter@osa.aero

# Twilio (Conference bridge — copilot during broker calls)
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=

# Deepgram (Real-time transcription — copilot audio stream)
DEEPGRAM_API_KEY=

# Anthropic (for respond capability)
ANTHROPIC_API_KEY=

# Application
OSA_BROKER_PHONE=
OSA_BROKER_NAME=Phelipe
DASHBOARD_WS_PORT=5175
NODE_ENV=production
```

## 5.3 Success Metrics (Day 30)

- [ ] 5+ deals processed through email channel end-to-end
- [ ] 3+ operator calls transcribed with entity detection
- [ ] SDR auto-qualification accuracy > 90%
- [ ] Average inbound-to-deal-creation time < 5 seconds
- [ ] At least 2 response templates graduated to autonomy
- [ ] Zero unintended outbound messages (autonomy gate holds)
- [ ] Learning loop capturing operator response times from all channels
- [ ] Conversation threading works across email + SMS on same deal
- [ ] Draft evaluator catches at least 1 issue per 10 drafts (proves it's working)
- [ ] Edit memory populated after first 5 broker edits (reflection loop active)
- [ ] Stage regression tested on at least 1 real deal (client changes mind)

## 5.4 Future Optimizations (Post-50 Deals)

These are documented for future implementation. DO NOT build now.

**Parallelization (Anthropic pattern):**
Guardian's 5 validation passes contain independent checks within each pass.
Post-50 deals, evaluate running checks within a pass concurrently (e.g. runway
check and pax check don't depend on each other). Also evaluate concurrent
deal processing when multiple deals are active simultaneously.

**Multi-Agent coordination:**
When deal volume exceeds 10 concurrent deals, or when a second broker is hired,
evaluate splitting the single orchestrator into a coordinator + worker agents.
The current architecture supports this cleanly because capabilities are isolated
functions with typed inputs/outputs — they can become worker agents without
rewriting their internals.

**Whisper fine-tuning:**
After 100+ transcribed calls, evaluate fine-tuning Whisper on the correction
dataset (broker corrects transcription errors in Mission Control). Domain-specific
vocabulary (ICAO codes, tail numbers, pricing language) should improve
transcription accuracy over the base model.
