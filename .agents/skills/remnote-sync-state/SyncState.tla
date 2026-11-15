----------------------------- MODULE SyncState -----------------------------
EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS Mode, MaxInterrupts, Interference
VARIABLE s
vars == <<s>>

Steps == 1..2
Statuses == {"none", "started", "verified"}
Attempted == {i \in Steps : s.steps[i] # "none"}
ObservedNew == IF s.known \in s.created THEN s.known ELSE 0
Exact == /\ s.observedNew = s.wantedId
         /\ s.observedTag = s.wantedTag
         /\ ~s.observedForeign

Init == s = [
  phase |-> "beforeInput", i |-> 1,
  steps |-> <<"none", "none">>, known |-> 0, firstKnown |-> 0,
  created |-> {}, lastCreated |-> 0,
  sends |-> <<0, 0>>, applied |-> <<0, 0>>, pending |-> <<0, 0>>,
  wantedId |-> 0, wantedTag |-> FALSE,
  tag |-> FALSE, foreign |-> FALSE,
  observedNew |-> 0, observedTag |-> FALSE, observedForeign |-> FALSE,
  input |-> 0, observedInput |-> 0,
  final |-> FALSE, proofId |-> 0, proofTag |-> FALSE,
  proofForeign |-> FALSE, proofExact |-> FALSE,
  authorized |-> FALSE, publicationInput |-> 2,
  interrupts |-> 0]

ReadGuardInput ==
  /\ s.phase \in {"beforeInput", "afterInput"}
  /\ s' = [s EXCEPT !.observedInput = s.input,
                     !.phase = IF s.phase = "beforeInput"
                               THEN "beforeNew" ELSE "afterNew"]

ReadNew ==
  /\ s.phase \in {"beforeNew", "afterNew", "resumeNew", "finalNew"}
  /\ s' = [s EXCEPT
      !.observedNew = ObservedNew,
      !.phase = CASE s.phase = "beforeNew" -> "beforeTags"
                  [] s.phase = "afterNew" -> "afterTags"
                  [] s.phase = "resumeNew" -> "resumeTags"
                  [] OTHER -> "finalTags"]

ReadTags ==
  /\ s.phase \in {"beforeTags", "afterTags", "resumeTags", "finalTags"}
  /\ s' = [s EXCEPT
      !.observedTag = s.tag, !.observedForeign = s.foreign,
      !.phase = CASE s.phase = "beforeTags" -> "beforeGuard"
                  [] s.phase = "afterTags" -> "afterGuard"
                  [] s.phase = "resumeTags" -> "resumeGuard"
                  [] OTHER -> "finalGuard"]

CheckBefore ==
  /\ s.phase = "beforeGuard"
  /\ s' = [s EXCEPT !.phase = IF Exact /\ s.observedInput = 0
                              THEN "persistStarted" ELSE "blocked"]

PersistStarted ==
  /\ s.phase = "persistStarted"
  /\ s' = [s EXCEPT !.steps[s.i] = "started", !.phase = "send"]

SendSdkCall ==
  /\ s.phase = "send"
  /\ s.sends[s.i] < 2
  /\ s' = [s EXCEPT !.sends[s.i] = @ + 1,
                     !.pending[s.i] = @ + 1, !.phase = "awaitReply"]

SdkCreate ==
  /\ s.pending[1] > 0
  /\ Cardinality(s.created) < 2
  /\ LET id == Cardinality(s.created) + 1 IN
      s' = [s EXCEPT !.created = @ \cup {id}, !.lastCreated = id,
                     !.pending[1] = @ - 1, !.applied[1] = @ + 1]

SdkAddTag ==
  /\ s.pending[2] > 0
  /\ s' = [s EXCEPT !.tag = TRUE, !.pending[2] = @ - 1,
                     !.applied[2] = @ + 1]

ReceiveReply ==
  /\ s.phase = "awaitReply"
  /\ s.applied[s.i] = s.sends[s.i]
  /\ s' = [s EXCEPT !.phase = IF s.i = 1 THEN "persistId" ELSE "acceptEffect"]

PersistId ==
  /\ s.phase = "persistId"
  /\ s' = [s EXCEPT !.known = s.lastCreated,
                     !.firstKnown = IF @ = 0 THEN s.lastCreated ELSE @,
                     !.phase = "acceptEffect"]

AcceptEffect ==
  /\ s.phase = "acceptEffect"
  /\ s' = [s EXCEPT !.wantedId = IF s.i = 1 THEN s.known ELSE @,
                     !.wantedTag = IF s.i = 2 THEN TRUE ELSE @,
                     !.phase = "afterInput"]

CheckAfter ==
  /\ s.phase = "afterGuard"
  /\ s' = [s EXCEPT !.phase = IF Exact /\ s.observedInput = 0
                              THEN "persistVerified" ELSE "blocked"]

PersistVerified ==
  /\ s.phase = "persistVerified"
  /\ s' = [s EXCEPT !.steps[s.i] = "verified", !.phase = "advance"]

Advance ==
  /\ s.phase = "advance"
  /\ s' = [s EXCEPT !.i = s.i + 1,
                     !.phase = IF s.i = 1 THEN "beforeInput" ELSE "finalNew"]

Interrupt ==
  /\ s.interrupts < MaxInterrupts
  /\ Attempted # {}
  /\ s.phase \notin {"blocked", "done", "resumeOffline", "resumeNew",
                      "resumeTags", "resumeGuard", "resumePersist"}
  /\ ~s.final
  /\ s' = [s EXCEPT !.phase = "resumeOffline", !.interrupts = @ + 1]

ResumeOffline ==
  /\ s.phase = "resumeOffline"
  /\ s' = IF s.input # 0
          THEN [s EXCEPT !.phase = "blocked"]
          ELSE IF Mode = "replay"
          THEN [s EXCEPT !.phase = "beforeInput", !.i = 1,
                         !.wantedId = s.known,
                         !.wantedTag = s.steps[2] # "none"]
          ELSE IF s.steps[1] # "none" /\ s.known = 0
          THEN [s EXCEPT !.phase = "blocked"]
          ELSE [s EXCEPT !.phase = "resumeNew",
                         !.wantedId = s.known,
                         !.wantedTag = s.steps[2] # "none"]

CheckResume ==
  /\ s.phase = "resumeGuard"
  /\ s' = [s EXCEPT !.phase = IF Exact /\ s.input = 0
                              THEN "resumePersist" ELSE "blocked"]

PersistRecognized ==
  /\ s.phase = "resumePersist"
  /\ LET next == IF s.steps[2] # "none" THEN 3 ELSE 2 IN
      s' = [s EXCEPT
        !.steps = [j \in Steps |-> IF j \in Attempted THEN "verified" ELSE "none"],
        !.i = next,
        !.phase = IF next = 3 THEN "finalNew" ELSE "beforeInput"]

CheckFinalObservation ==
  /\ s.phase = "finalGuard"
  /\ s' = [s EXCEPT
      !.proofId = s.observedNew, !.proofTag = s.observedTag,
      !.proofForeign = s.observedForeign, !.proofExact = Exact,
      !.phase = IF Exact \/ Mode = "skip-observation"
                THEN "persistFinal" ELSE "blocked"]

PersistFinal ==
  /\ s.phase = "persistFinal"
  /\ s' = [s EXCEPT !.final = TRUE, !.phase = "publicationInput"]

ReadPublicationInput ==
  /\ s.phase = "publicationInput"
  /\ s' = [s EXCEPT !.observedInput = s.input, !.phase = "publish"]

AuthorizePublication ==
  /\ s.phase = "publish"
  /\ s' = IF s.observedInput = 0 \/ Mode = "skip-input"
          THEN [s EXCEPT !.authorized = TRUE,
                         !.publicationInput = s.observedInput, !.phase = "done"]
          ELSE [s EXCEPT !.phase = "blocked"]

ExternalTag ==
  /\ Interference /\ ~s.foreign
  /\ s.phase \notin {"blocked", "done"}
  /\ s' = [s EXCEPT !.foreign = TRUE]

LocalEdit ==
  /\ Interference /\ s.input = 0
  /\ s.phase \notin {"blocked", "done"}
  /\ s' = [s EXCEPT !.input = 1]

Stopped == s.phase \in {"blocked", "done"} /\ UNCHANGED vars

Next == ReadGuardInput \/ ReadNew \/ ReadTags \/ CheckBefore \/ PersistStarted \/ SendSdkCall
        \/ SdkCreate \/ SdkAddTag \/ ReceiveReply \/ PersistId \/ AcceptEffect
        \/ CheckAfter \/ PersistVerified \/ Advance \/ Interrupt \/ ResumeOffline
        \/ CheckResume \/ PersistRecognized \/ CheckFinalObservation \/ PersistFinal
        \/ ReadPublicationInput \/ AuthorizePublication \/ ExternalTag \/ LocalEdit \/ Stopped

Spec == Init /\ [][Next]_vars

TypeOK == /\ s.i \in 1..3
          /\ s.steps \in [Steps -> Statuses]
          /\ s.sends \in [Steps -> 0..2]
          /\ s.pending \in [Steps -> 0..2]
          /\ s.applied \in [Steps -> 0..2]
          /\ s.created \subseteq 1..2
          /\ s.known \in 0..2
          /\ s.interrupts \in 0..MaxInterrupts

NoBlindReplay == \A j \in Steps : s.sends[j] <= 1
NoDuplicateCreate == Cardinality(s.created) <= 1
PersistedIdentityRetained == s.firstKnown = 0 \/ s.known = s.firstKnown
VerifiedPrefix == s.steps[2] = "none" \/ s.steps[1] = "verified"
OnlyExactObservedPublication ==
  s.authorized => /\ s.final /\ s.proofExact /\ s.proofId = s.known
                  /\ s.proofTag /\ ~s.proofForeign
                  /\ \A j \in Steps : s.steps[j] = "verified"
PublicationInputBound == s.authorized => s.publicationInput = 0

=============================================================================
