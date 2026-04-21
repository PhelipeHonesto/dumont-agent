# Charter classification investigation — 2026-04-17

## Context
Rebuild in progress, 7% done. Investigation of aircraft_class 
distribution raised questions about classification accuracy.

## Key findings
- 3.7% of legs classified as charter (75,117 of 2,057,679)
- 96.3% unclassified — correctly excluded (training, airlines, helos)
- Real charter gaps identified: C700, PC24
- E135 is ambiguous (Legacy 600 vs ERJ-135 regional — mostly regional)

## Fleet leader-per-aircraft by class
- turboprop: 13.2 legs/aircraft (highest utilization)
- super_mid: 10.2 legs/aircraft
- midsize: 8.1
- heavy: 5.8
- light: 5.5

Super-mid is the charter workhorse. Turboprops fly frequently 
but shorter missions.

## Action items for tomorrow
1. Add C700 (Citation Longitude) → super_mid
2. Add PC24 (Pilatus PC-24) → light
3. Document E135 exclusion (JSX/Contour contamination)
4. Write UPDATE script to reclassify existing rows

## Open questions for Phase 8
- Should we add operator-based classification layer?
- How to handle JSX/semi-scheduled ops in analytics?
- Quarterly map maintenance process?
