import { Field, Int, ObjectType } from '@nestjs/graphql';

/**
 * Every type here carries the `DockerFolders` prefix — see `container.model.ts`
 * for why that is a hard requirement rather than a naming preference.
 */

/**
 * Cached "latest GitHub release" for an image's source repo, ported from
 * `ReleaseNotes::payload()`.
 *
 * Only the read side is ported. `ReleaseNotes::fetchLatest()` — the actual
 * GitHub HTTP call, with its rate-limit budget and per-status TTLs — is
 * deliberately not: it is the plugin's one call out to the public internet,
 * kept out of `DockerClient` on purpose in PHP too, and the still-running PHP
 * cron (`check-updates.php`) already refreshes the `release_notes` table on
 * its own schedule regardless of `backend_mode`. This type only ever surfaces
 * whatever that cron already wrote. A "check now" click in GraphQL mode
 * therefore will not fetch fresher release notes than the last cron run; see
 * `UpdatesService` for detail.
 */
@ObjectType()
export class DockerFoldersReleaseNote {
    @Field(() => String, { nullable: true })
    tag!: string | null;

    @Field(() => String, { nullable: true })
    name!: string | null;

    @Field(() => Int, { nullable: true, description: 'Unix seconds' })
    publishedAt!: number | null;

    @Field(() => String, { nullable: true })
    url!: string | null;

    @Field(() => String, { description: 'Plain text, already length-capped server-side.' })
    summary!: string;

    @Field(() => Int, { description: 'Unix seconds' })
    fetchedAt!: number;
}

/** One image's entry, ported from `imageCheckResult()` in `config.php`. */
@ObjectType()
export class DockerFoldersImageUpdateStatus {
    @Field(() => String)
    image!: string;

    @Field(() => String, { nullable: true })
    localDigest!: string | null;

    @Field(() => String, { nullable: true })
    remoteDigest!: string | null;

    @Field(() => Boolean)
    updateAvailable!: boolean;

    @Field(() => Int, { description: 'Unix seconds' })
    checkedAt!: number;

    @Field(() => String, { nullable: true })
    error!: string | null;

    @Field(() => String, { nullable: true })
    sourceUrl!: string | null;

    @Field(() => String, {
        nullable: true,
        description: 'Normalised "owner/name" when sourceUrl points at GitHub, else null.',
    })
    sourceRepo!: string | null;

    @Field(() => DockerFoldersReleaseNote, { nullable: true })
    release!: DockerFoldersReleaseNote | null;
}

/**
 * The terminal result of a pull, ported from `pull.php`'s `complete`/`error`
 * SSE events. There is no progress payload here — see `UpdatesService.pullImage`
 * for why the per-chunk progress stream is not ported.
 */
@ObjectType()
export class DockerFoldersImagePullResult {
    @Field(() => Boolean)
    success!: boolean;

    @Field(() => String)
    image!: string;

    @Field(() => String, { nullable: true })
    error!: string | null;
}
