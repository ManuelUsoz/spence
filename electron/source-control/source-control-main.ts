import { Layer } from 'effect';
import { layerStoreUserData } from '../store/store';
import { layerOperations } from './operations';
import { layerReservationCoordinator } from './reservation-coordinator';
import { layerReviewRegistry } from './review-registry';

/** Single app-lifetime ReservationCoordinator shared across Sessions, Worktrees, and Source Control. */
export const layerReservationCoordinatorMain = layerReservationCoordinator;

/** Single app-lifetime ReviewRegistry shared across Source Control domains. */
export const layerReviewRegistryMain = layerReviewRegistry;

/** Single app-lifetime durable Operations service backed by `<userData>/spence/operations`. */
export const layerOperationsMain = layerOperations.pipe(
  Layer.provide(Layer.mergeAll(layerReservationCoordinatorMain, layerStoreUserData)),
  Layer.orDie,
);
