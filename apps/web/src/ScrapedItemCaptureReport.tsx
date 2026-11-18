import type { ScrapedCaptureDiagnostics } from '@poe-worksmith/contracts';

import { formatTimestamp } from './dateTime.js';
import { partialReasonLabel } from './scrapedItemsModel.js';

const count = new Intl.NumberFormat('en-US');

function Fact({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="scraped-fact">
      <dt>{label}</dt>
      <dd>{typeof value === 'number' ? count.format(value) : value}</dd>
    </div>
  );
}

/**
 * Collection quality and listing comparability are separate questions: a
 * complete capture can match nothing, and a partial one can still match.
 */
export function ScrapedItemCaptureReport({
  capture,
}: {
  capture: ScrapedCaptureDiagnostics;
}) {
  const { listings } = capture;
  return (
    <div className="scraped-report">
      <section aria-label="Collection">
        <h4>Collection</h4>
        <dl className="scraped-facts">
          <Fact label="Reported by Trade" value={capture.reportedTotal} />
          <Fact label="Listings fetched" value={capture.fetched} />
          <Fact
            label="Coverage"
            value={capture.coverage === 'complete' ? 'Complete' : 'Partial'}
          />
          <Fact label="Price slices" value={capture.slices} />
          <Fact label="Duration" value={`${capture.durationMs} ms`} />
          <Fact label="Captured" value={formatTimestamp(capture.capturedAt)} />
        </dl>
        {capture.partialReason ? (
          <p className="scraped-note">
            Partial because: {partialReasonLabel(capture.partialReason)}
          </p>
        ) : null}
      </section>
      <section aria-label="Comparability">
        <h4>Matching</h4>
        {listings ? (
          <>
            <dl className="scraped-facts">
              <Fact label="Stored listings" value={listings.stored} />
              <Fact label="With seller and price" value={listings.priced} />
              <Fact label="Complete item data" value={listings.completeItems} />
              <Fact label="Analyzed" value={listings.analyzed} />
              <Fact label="Matched" value={listings.matched} />
              <Fact label="Comparable sellers" value={listings.comparable} />
              <Fact label="Rejected" value={listings.rejected} />
              <Fact label="Unknown" value={listings.unknown} />
              <Fact
                label="Excluded (currency or league)"
                value={listings.excluded}
              />
              <Fact label="Unreadable" value={listings.unreadable} />
            </dl>
            {capture.coverage === 'complete' && listings.matched === 0 ? (
              <p className="scraped-note">
                The collection is complete. No listing satisfies every
                requirement, so this is a matching result, not a scraping
                failure.
              </p>
            ) : null}
            {capture.reasons.length ? (
              <table className="scraped-table">
                <caption>Why listings did not match</caption>
                <thead>
                  <tr>
                    <th scope="col">Reason</th>
                    <th scope="col">Result</th>
                    <th scope="col" className="scraped-table__number">
                      Listings
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {capture.reasons.map(({ reason, status, count: total }) => (
                    <tr key={`${status}:${reason}`}>
                      <td>{reason}</td>
                      <td>{status === 'rejected' ? 'Rejected' : 'Unknown'}</td>
                      <td className="scraped-table__number">
                        {count.format(total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </>
        ) : (
          <p className="scraped-note">
            {capture.listingsUnavailable === 'superseded-by-later-capture'
              ? 'Listing-level matching is only kept for the newest capture, and a later capture replaced this one.'
              : 'The stored search could not be read, so listings were not matched.'}
          </p>
        )}
      </section>
    </div>
  );
}
