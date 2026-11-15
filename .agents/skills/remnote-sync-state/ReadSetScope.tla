--------------------------- MODULE ReadSetScope ---------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Mode, Fault
VARIABLE s
vars == <<s>>

\* A fixed footprint projection: remove card -> oldTag, then edit other.
\* Stable ancestors/card-family members are omitted, not proved irrelevant.
Scope == 1..3
Card == 1
OldTag == 2
Other == 3
Before(i) == IF i = 1 THEN {Card, OldTag} ELSE {Other}
After(i) == IF i = 1 THEN {Card} ELSE {Other}
Zero == [id \in Scope |-> 0]
InitialTags == [id \in Scope |-> IF id = Card THEN 1 ELSE 0]

Required == CASE s.round = "initial" -> Scope
                [] s.round = "before" -> Before(s.i)
                [] s.round = "after" -> Before(s.i) \cup After(s.i)
                [] OTHER -> Scope
Selected == CASE s.round = "initial" /\ Mode = "narrow-initial" -> Before(1)
                [] s.round = "final" /\ Mode = "narrow-final" -> After(2)
                [] s.round = "after" /\ Mode = "drop-old-target" -> After(s.i)
                [] OTHER -> Required

Init == s = [
  phase |-> "select", round |-> "initial", i |-> 1, cursor |-> 1,
  nativeRevision |-> Zero, nativeCard |-> Zero, nativeHistory |-> Zero,
  nativeTags |-> InitialTags, nativePowerup |-> Zero,
  missingTags |-> [id \in Scope |-> FALSE],
  missingPowerup |-> [id \in Scope |-> FALSE],
  wantedTags |-> InitialTags,
  observedRevision |-> Zero, observedCard |-> Zero, observedHistory |-> Zero,
  observedTags |-> InitialTags, observedPowerup |-> Zero,
  selected |-> {}, seen |-> {}, initialCover |-> {}, finalCover |-> {},
  postCover |-> [i \in 1..2 |-> {}], verified |-> {}, writes |-> 0,
  badCard |-> FALSE, badHistory |-> FALSE, missingRelations |-> FALSE,
  edited |-> FALSE, proof |-> FALSE, published |-> FALSE]

SelectReadSet ==
  /\ s.phase = "select"
  /\ s' = [s EXCEPT !.selected = Selected, !.seen = {},
                     !.cursor = 1, !.phase = "nextRem"]

NextRem ==
  /\ s.phase = "nextRem"
  /\ s' = IF s.cursor > 3
          THEN [s EXCEPT !.phase = "check"]
          ELSE IF s.cursor \in s.selected
          THEN [s EXCEPT !.phase = "readRevision"]
          ELSE [s EXCEPT !.cursor = @ + 1]

\* Each native observation is separate. No batch or Rem snapshot is atomic.
ReadRevision ==
  /\ s.phase = "readRevision"
  /\ s' = [s EXCEPT !.observedRevision[s.cursor] = s.nativeRevision[s.cursor],
                     !.phase = "readCards"]

\* One getCards response for one Rem; IDs and its history are read together.
ReadCards ==
  /\ s.phase = "readCards"
  /\ s' = [s EXCEPT !.observedCard[s.cursor] = s.nativeCard[s.cursor],
                     !.observedHistory[s.cursor] = s.nativeHistory[s.cursor],
                     !.phase = "readTags"]

ReadTags ==
  /\ s.phase = "readTags"
  /\ s' = [s EXCEPT !.observedTags[s.cursor] =
                       IF s.missingTags[s.cursor] THEN 2 ELSE s.nativeTags[s.cursor],
                     !.phase = "readPowerup"]

ReadPowerup ==
  /\ s.phase = "readPowerup"
  /\ s' = [s EXCEPT !.observedPowerup[s.cursor] =
                       IF s.missingPowerup[s.cursor] THEN 2 ELSE s.nativePowerup[s.cursor],
                     !.seen = @ \cup {s.cursor},
                     !.cursor = @ + 1, !.phase = "nextRem"]

CardExact == \A id \in s.selected : s.observedCard[id] = 0
HistoryExact == \A id \in s.selected : s.observedHistory[id] = 0
RelationsPresent == \A id \in s.selected :
  s.observedTags[id] # 2 /\ s.observedPowerup[id] # 2
\* withNativeSnapshot could restore a missing fact; only the broken mode lets
\* that merged cache replace validation of the raw native response.
RevisionExact == \A id \in s.selected :
  /\ s.observedRevision[id] = 0
  /\ (s.observedTags[id] = s.wantedTags[id]
      \/ (Mode = "cached-guards" /\ s.observedTags[id] = 2))
  /\ (s.observedPowerup[id] = 0
      \/ (Mode = "cached-guards" /\ s.observedPowerup[id] = 2))
Exact == /\ RevisionExact
         /\ (Mode = "cached-guards" \/ (CardExact /\ HistoryExact /\ RelationsPresent))

CheckObserved ==
  /\ s.phase = "check"
  /\ s' = IF ~Exact
          THEN [s EXCEPT !.phase = "blocked"]
          ELSE [s EXCEPT
            !.badCard = @ \/ ~CardExact,
            !.badHistory = @ \/ ~HistoryExact,
            !.missingRelations = @ \/ ~RelationsPresent,
            !.initialCover = IF s.round = "initial" THEN s.seen ELSE @,
            !.finalCover = IF s.round = "final" THEN s.seen ELSE @,
            !.postCover[s.i] = IF s.round = "after" THEN s.seen ELSE @,
            !.phase = CASE s.round \in {"initial", "before"} -> "write"
                          [] s.round = "after" -> "persistVerified"
                          [] OTHER -> "persistProof"]

SdkWrite ==
  /\ s.phase = "write"
  /\ s' = [s EXCEPT
      !.nativeTags[IF s.i = 1 THEN Card ELSE Other] = IF s.i = 1 THEN 0 ELSE 1,
      !.writes = @ + 1, !.phase = "reply"]

ReceiveReply ==
  /\ s.phase = "reply"
  /\ s' = [s EXCEPT
      !.wantedTags[IF s.i = 1 THEN Card ELSE Other] = IF s.i = 1 THEN 0 ELSE 1,
      !.round = "after", !.phase = "select"]

PersistVerified ==
  /\ s.phase = "persistVerified"
  /\ s' = [s EXCEPT !.verified = @ \cup {s.i}, !.phase = "advance"]

Advance ==
  /\ s.phase = "advance"
  /\ s' = [s EXCEPT !.i = 2,
                     !.round = IF s.i = 1 THEN "before" ELSE "final",
                     !.phase = "select"]

PersistProof ==
  /\ s.phase = "persistProof"
  /\ s' = [s EXCEPT !.proof = TRUE, !.phase = "publish"]

Publish ==
  /\ s.phase = "publish"
  /\ s' = [s EXCEPT !.published = TRUE, !.phase = "done"]

ExternalEdit ==
  /\ ~s.edited /\ Fault # "none"
  /\ s.phase \notin {"done", "blocked"}
  /\ \E id \in Scope, field \in {"revision", "card", "history", "tags", "powerup"} :
      /\ Fault = "any" \/ Fault = field
      /\ s' = [s EXCEPT !.edited = TRUE,
          !.nativeRevision[id] = IF field = "revision" THEN 1 ELSE @,
          !.nativeCard[id] = IF field = "card" THEN 1 ELSE @,
          !.nativeHistory[id] = IF field = "history" THEN 1 ELSE @,
          !.missingTags[id] = IF field = "tags" THEN TRUE ELSE @,
          !.missingPowerup[id] = IF field = "powerup" THEN TRUE ELSE @]

Stopped == s.phase \in {"done", "blocked"} /\ UNCHANGED vars
Next == SelectReadSet \/ NextRem \/ ReadRevision \/ ReadCards \/ ReadTags \/ ReadPowerup
        \/ CheckObserved \/ SdkWrite \/ ReceiveReply \/ PersistVerified \/ Advance
        \/ PersistProof \/ Publish \/ ExternalEdit \/ Stopped
Spec == Init /\ [][Next]_vars

TypeOK == /\ s.i \in 1..2 /\ s.writes \in 0..2 /\ s.cursor \in 1..4
          /\ s.selected \subseteq Scope /\ s.seen \subseteq Scope
          /\ s.verified \subseteq 1..2
FullInitialCoverage == s.writes > 0 => s.initialCover = Scope
TouchedPostCoverage == \A i \in s.verified : Before(i) \cup After(i) \subseteq s.postCover[i]
FullFinalCoverage == s.published => s.proof /\ s.finalCover = Scope
ObservedCardIdentityPreserved == ~s.badCard
ObservedReviewHistoryPreserved == ~s.badHistory
FreshRelationshipObservation == ~s.missingRelations
PublicationUsesVerifiedSteps == s.published => s.verified = 1..2

=============================================================================
