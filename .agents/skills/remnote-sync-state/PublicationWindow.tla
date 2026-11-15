------------------------- MODULE PublicationWindow -------------------------
EXTENDS Naturals
VARIABLE s
vars == <<s>>

Init == s = [phase |-> "guard", native |-> 0, expected |-> 0,
             observed |-> 0, proof |-> 0, atPublication |-> 0,
             edited |-> FALSE, published |-> FALSE]

ReadGuard ==
  /\ s.phase = "guard"
  /\ s' = [s EXCEPT !.observed = s.native, !.phase = "write"]

SdkWrite ==
  /\ s.phase = "write"
  /\ s' = [s EXCEPT !.native = 1, !.phase = "reply"]

ReceiveReply ==
  /\ s.phase = "reply"
  /\ s' = [s EXCEPT !.expected = 1, !.phase = "readback"]

ReadBack ==
  /\ s.phase = "readback"
  /\ s' = [s EXCEPT !.observed = s.native, !.phase = "verify"]

Verify ==
  /\ s.phase = "verify"
  /\ s' = [s EXCEPT !.phase = IF s.observed = s.expected
                              THEN "persistProof" ELSE "blocked"]

PersistProof ==
  /\ s.phase = "persistProof"
  /\ s' = [s EXCEPT !.proof = s.observed, !.phase = "publish"]

ExternalEdit ==
  /\ s.phase \notin {"done", "blocked"} /\ ~s.edited
  /\ s' = [s EXCEPT !.native = 2, !.edited = TRUE]

Publish ==
  /\ s.phase = "publish"
  /\ s' = [s EXCEPT !.atPublication = s.native,
                     !.published = TRUE, !.phase = "done"]

Stopped == s.phase \in {"done", "blocked"} /\ UNCHANGED vars
Next == ReadGuard \/ SdkWrite \/ ReceiveReply \/ ReadBack \/ Verify \/ PersistProof \/ ExternalEdit
        \/ Publish \/ Stopped
Spec == Init /\ [][Next]_vars

ObservedCompletion == s.published => s.proof = s.expected
FreshAtPublication == s.published => s.atPublication = s.proof
=============================================================================
