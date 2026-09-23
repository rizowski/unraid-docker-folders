import { NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DatabaseService } from '../../db/database.service.js';
import type { EventBusService } from '../../events/event-bus.service.js';
import { FolderService } from '../folder.service.js';
import { createMigratedDatabase, type TempDatabase } from './migrate.js';

describe('FolderService writes', () => {
    let temp: TempDatabase;
    let service: FolderService;
    let publish: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        temp = createMigratedDatabase();
        publish = vi.fn();
        service = new FolderService(new DatabaseService(temp.path), {
            publish,
        } as unknown as EventBusService);
    });

    afterEach(() => {
        temp.cleanup();
    });

    describe('createFolder', () => {
        it('uses the same defaults PHP uses', () => {
            const folder = service.createFolder({});

            expect(folder.name).toBe('New Folder');
            expect(folder.icon).toBeNull();
            expect(folder.color).toBeNull();
            expect(folder.collapsed).toBe(false);
            expect(folder.sortMode).toBe('manual');
            expect(folder.containers).toEqual([]);
            expect(folder.createdAt).toBe(folder.updatedAt);
        });

        it('puts each new folder at the end', () => {
            expect(service.createFolder({ name: 'A' }).position).toBe(0);
            expect(service.createFolder({ name: 'B' }).position).toBe(1);
            expect(service.createFolder({ name: 'C' }).position).toBe(2);
        });

        it('falls back to manual for a sort mode it does not know', () => {
            expect(service.createFolder({ sortMode: 'size-desc' }).sortMode).toBe('manual');
            expect(service.createFolder({ sortMode: 'name-desc' }).sortMode).toBe('name-desc');
        });

        it('stores collapsed as the integer the PHP side reads', () => {
            const folder = service.createFolder({ name: 'A' });

            const [row] = temp.rows('SELECT collapsed FROM folders WHERE id = ?', [folder.id]);
            expect(row.collapsed).toBe(0);
        });

        it('tells open tabs to refetch', () => {
            service.createFolder({});

            expect(publish).toHaveBeenCalledWith('folder', 'create');
        });
    });

    describe('updateFolder', () => {
        it('leaves every column the caller did not name', () => {
            const before = service.createFolder({ name: 'Media', icon: 'film', color: '#fff' });

            const after = service.updateFolder(before.id, { name: 'Movies' });

            expect(after.name).toBe('Movies');
            expect(after.icon).toBe('film');
            expect(after.color).toBe('#fff');
            expect(after.position).toBe(before.position);
        });

        it('treats an explicit null as no change, the way PHP isset does', () => {
            const before = service.createFolder({ name: 'Media', icon: 'film' });

            const after = service.updateFolder(before.id, { icon: null as unknown as undefined });

            expect(after.icon).toBe('film');
        });

        it('ignores a sort mode that is not one of the six', () => {
            const before = service.createFolder({ sortMode: 'name-asc' });

            expect(service.updateFolder(before.id, { sortMode: 'nonsense' }).sortMode).toBe(
                'name-asc'
            );
        });

        it('writes collapsed back as an integer', () => {
            const folder = service.createFolder({});

            service.updateFolder(folder.id, { collapsed: true });

            const [row] = temp.rows('SELECT collapsed FROM folders WHERE id = ?', [folder.id]);
            expect(row.collapsed).toBe(1);
        });

        it('refuses a folder that is not there, and announces nothing', () => {
            expect(() => service.updateFolder(999, { name: 'x' })).toThrow(NotFoundException);
            expect(publish).not.toHaveBeenCalledWith('folder', 'update');
        });
    });

    describe('deleteFolder', () => {
        it('takes the memberships with it, through the cascade', () => {
            const folder = service.createFolder({ name: 'Media' });
            service.addContainerToFolder(folder.id, 'abc123', 'plex');

            service.deleteFolder(folder.id);

            expect(temp.rows('SELECT * FROM container_folders')).toEqual([]);
        });

        it('refuses a folder that is not there', () => {
            expect(() => service.deleteFolder(999)).toThrow(NotFoundException);
        });
    });

    describe('addContainerToFolder', () => {
        it('appends at the end of the folder', () => {
            const folder = service.createFolder({ name: 'Media' });

            service.addContainerToFolder(folder.id, 'id-plex', 'plex');
            const after = service.addContainerToFolder(folder.id, 'id-sonarr', 'sonarr');

            expect(after.containers.map((c) => [c.containerName, c.position])).toEqual([
                ['plex', 0],
                ['sonarr', 1],
            ]);
        });

        it('moves a container out of the folder it was in', () => {
            const first = service.createFolder({ name: 'A' });
            const second = service.createFolder({ name: 'B' });
            service.addContainerToFolder(first.id, 'id-plex', 'plex');

            service.addContainerToFolder(second.id, 'id-plex', 'plex');

            expect(service.getFolder(first.id)?.containers).toEqual([]);
            expect(service.getFolder(second.id)?.containers).toHaveLength(1);
        });

        it('keeps the row, and its position, when the container is already here', () => {
            const folder = service.createFolder({ name: 'Media' });
            service.addContainerToFolder(folder.id, 'id-plex', 'plex');
            service.addContainerToFolder(folder.id, 'id-sonarr', 'sonarr');

            // Unraid gives a container a new id every time it is recreated.
            const after = service.addContainerToFolder(folder.id, 'id-plex-v2', 'plex');

            const plex = after.containers.find((c) => c.containerName === 'plex');
            expect(plex?.position).toBe(0);
            // Refreshed, because reorderContainers matches on this column and a
            // stale id would make drag-and-drop skip the row.
            expect(plex?.containerId).toBe('id-plex-v2');
        });

        it('lets the Compose sync manage the container again', () => {
            const folder = service.createFolder({ name: 'Media' });
            service.addContainerToFolder(folder.id, 'id-plex', 'plex');
            service.removeContainerFromFolder('plex');

            service.addContainerToFolder(folder.id, 'id-plex', 'plex');

            expect(temp.rows('SELECT * FROM compose_sync_exclusions')).toEqual([]);
        });

        it('refuses a folder that is not there', () => {
            expect(() => service.addContainerToFolder(999, 'id', 'plex')).toThrow(
                NotFoundException
            );
        });
    });

    describe('removeContainerFromFolder', () => {
        it('records the exclusion, so the Compose sync cannot undo the removal', () => {
            const folder = service.createFolder({ name: 'Media' });
            service.addContainerToFolder(folder.id, 'id-plex', 'plex');

            service.removeContainerFromFolder('plex');

            expect(service.getFolder(folder.id)?.containers).toEqual([]);
            expect(
                temp.rows('SELECT container_name FROM compose_sync_exclusions')
            ).toEqual([{ container_name: 'plex' }]);
        });
    });

    describe('reorderContainers', () => {
        it('renumbers by container id, first to last', () => {
            const folder = service.createFolder({ name: 'Media' });
            service.addContainerToFolder(folder.id, 'id-a', 'a');
            service.addContainerToFolder(folder.id, 'id-b', 'b');
            service.addContainerToFolder(folder.id, 'id-c', 'c');

            const after = service.reorderContainers(folder.id, ['id-c', 'id-a', 'id-b']);

            expect(after.containers.map((c) => c.containerName)).toEqual(['c', 'a', 'b']);
        });

        it('leaves a container in another folder alone', () => {
            const mine = service.createFolder({ name: 'Mine' });
            const other = service.createFolder({ name: 'Other' });
            service.addContainerToFolder(mine.id, 'id-a', 'a');
            service.addContainerToFolder(other.id, 'id-b', 'b');

            service.reorderContainers(mine.id, ['id-b', 'id-a']);

            expect(service.getFolder(other.id)?.containers[0].position).toBe(0);
        });
    });

    describe('reorderFolders', () => {
        it('renumbers by id, first to last', () => {
            const a = service.createFolder({ name: 'A' });
            const b = service.createFolder({ name: 'B' });
            const c = service.createFolder({ name: 'C' });

            service.reorderFolders([c.id, a.id, b.id]);

            expect(service.getFolders().map((f) => f.name)).toEqual(['C', 'A', 'B']);
        });
    });

    describe('setUnfolderedOrder', () => {
        it('replaces the whole list, so an absent name loses its row', () => {
            service.setUnfolderedOrder(['a', 'b', 'c']);

            expect(service.setUnfolderedOrder(['c', 'a'])).toEqual(['c', 'a']);
        });

        it('skips duplicates and empty names, and keeps positions contiguous', () => {
            const order = service.setUnfolderedOrder(['a', '', 'b', 'a', 'c']);

            expect(order).toEqual(['a', 'b', 'c']);
            expect(temp.rows('SELECT position FROM unfoldered_order ORDER BY position')).toEqual([
                { position: 0 },
                { position: 1 },
                { position: 2 },
            ]);
        });

        it('refuses a name longer than the column is meant to hold', () => {
            expect(() => service.setUnfolderedOrder(['x'.repeat(256)])).toThrow(/255/);
        });

        it('leaves the saved order alone when one name is rejected', () => {
            service.setUnfolderedOrder(['a', 'b']);

            expect(() => service.setUnfolderedOrder(['c', 'x'.repeat(256)])).toThrow();
            expect(service.getUnfolderedOrder()).toEqual(['a', 'b']);
        });
    });

    describe('announcements', () => {
        it('names an action for every write, so no open tab is left stale', () => {
            const folder = service.createFolder({ name: 'Media' });
            service.updateFolder(folder.id, { name: 'Movies' });
            service.addContainerToFolder(folder.id, 'id-plex', 'plex');
            service.reorderContainers(folder.id, ['id-plex']);
            service.removeContainerFromFolder('plex');
            service.reorderFolders([folder.id]);
            service.setUnfolderedOrder(['a']);
            service.forgetContainer('a');
            service.deleteFolder(folder.id);

            expect(publish.mock.calls.map((call) => call[1])).toEqual([
                'create',
                'update',
                'add_container',
                'reorder_containers',
                'remove_container',
                'reorder',
                'reorder_unfoldered',
                'forget_container',
                'delete',
            ]);
            expect(publish.mock.calls.every((call) => call[0] === 'folder')).toBe(true);
        });

        it('stays quiet when the write rolled back', () => {
            expect(() => service.setUnfolderedOrder(['x'.repeat(256)])).toThrow();
            expect(() => service.deleteFolder(999)).toThrow();

            expect(publish).not.toHaveBeenCalled();
        });
    });

    describe('transactions', () => {
        it('rolls the whole write back when part of it fails', () => {
            const folder = service.createFolder({ name: 'Media' });
            service.addContainerToFolder(folder.id, 'id-plex', 'plex');

            // A membership pointing at no folder violates the foreign key, and
            // the PRAGMA that enforces it is set inside write().
            expect(() =>
                new DatabaseService(temp.path).write((db) => {
                    db.prepare('DELETE FROM container_folders WHERE container_name = ?').run('plex');
                    db.prepare(
                        `INSERT INTO container_folders (container_id, container_name, folder_id, position)
                         VALUES (?, ?, ?, ?)`
                    ).run('id-x', 'x', 999, 0);
                })
            ).toThrow();

            expect(service.getFolder(folder.id)?.containers).toHaveLength(1);
        });
    });

    describe('getLayout', () => {
        it('answers with what the writes just put there', () => {
            const media = service.createFolder({ name: 'Media', icon: 'film', color: '#b7f019' });
            service.addContainerToFolder(media.id, 'id-plex', 'plex');
            service.setUnfolderedOrder(['nginx', 'redis']);

            const layout = service.getLayout();

            expect(layout.folders).toHaveLength(1);
            expect(layout.folders[0].containers[0].containerName).toBe('plex');
            expect(layout.unfolderedOrder).toEqual(['nginx', 'redis']);
        });
    });
});
