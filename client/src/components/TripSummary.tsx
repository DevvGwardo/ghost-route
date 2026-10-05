import { Bike, Car, Footprints, Pencil } from 'lucide-react';
import type { TravelProfile } from '../../../shared/src/types';

// Phone-width stand-in for the full directions card once routes are shown.
// The full card (two fields, suggestions, mode chips, options, Find) took over
// half a 390px screen and pushed the route itself under the panels. This keeps
// the trip readable in two lines; tapping it brings the full editor back.
interface TripSummaryProps {
  originLabel: string;
  destinationLabel: string;
  profile: TravelProfile;
  onEdit: () => void;
}

const MODE_ICON = { driving: Car, walking: Footprints, cycling: Bike } as const;

export default function TripSummary({ originLabel, destinationLabel, profile, onEdit }: TripSummaryProps) {
  const Icon = MODE_ICON[profile] ?? Car;
  return (
    <button
      type="button"
      className="gm-trip-summary"
      onClick={onEdit}
      aria-label={`Edit trip: from ${originLabel || 'origin'} to ${destinationLabel || 'destination'}`}
    >
      <span className="gm-trip-mode" aria-hidden="true">
        <Icon size={18} />
      </span>
      <span className="gm-trip-lines">
        <span className="gm-trip-line">
          <span className="gm-trip-dot origin" aria-hidden="true" />
          <span className="gm-trip-text">{originLabel || 'Starting point'}</span>
        </span>
        <span className="gm-trip-line">
          <span className="gm-trip-dot dest" aria-hidden="true" />
          <span className="gm-trip-text">{destinationLabel || 'Destination'}</span>
        </span>
      </span>
      <span className="gm-trip-edit" aria-hidden="true">
        <Pencil size={16} />
      </span>
    </button>
  );
}
