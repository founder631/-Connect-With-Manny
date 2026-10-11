#!/usr/bin/env python3
"""Choose one inspiration and generate one photo on the Spark."""
import argparse
import fcntl
import hashlib
import json
import sys
import uuid
from pathlib import Path
import studio_runtime as studio

ROOT = Path(__file__).resolve().parent

def choose(items, label):
    print('\n' + label)
    for index, item in enumerate(items, 1):
        print(f'  {index}. {item["name"]}')
    while True:
        answer = input('Choose a number (or q to quit): ').strip()
        if answer.lower() == 'q':
            raise KeyboardInterrupt
        if answer.isdigit() and 1 <= int(answer) <= len(items):
            return items[int(answer) - 1]
        print('Choose one of the numbers above.')

def main():
    parser = argparse.ArgumentParser(description='Generate one photo from your Mad Scientist or Lemonade & Patron inspirations. Local ComfyUI only.')
    parser.add_argument('--scene', help='Scene ID. Use --list to see all IDs.')
    parser.add_argument('--list', action='store_true', help='Show the 16 inspirations without starting generation.')
    parser.add_argument('--photo', type=Path, default=ROOT / 'reference.png', help='Reference JPG, PNG, or WebP; defaults to your included photo.')
    parser.add_argument('--format', choices=studio.FORMATS, default='portrait')
    parser.add_argument('--output', type=Path, default=ROOT / 'Results', help='Folder for finished photos.')
    parser.add_argument('--check', action='store_true', help='Check ComfyUI and models without generating.')
    parser.add_argument('--new', action='store_true', help='Start a fresh variation of an already completed scene.')
    parser.add_argument('--yes', action='store_true', help='Generate the selected scene without the interactive review prompt.')
    args = parser.parse_args()
    try:
        catalog = json.loads((ROOT / 'catalog.json').read_text())
        if args.list:
            for entry in catalog:
                print(entry['id'] + '  ' + entry['pack'] + ' / ' + entry['title'])
            return 0
        if args.scene:
            matches = [entry for entry in catalog if entry['id'] == args.scene]
            if not matches:
                raise RuntimeError('Unknown scene. Run python3 generate.py --list to see the choices.')
            entry = matches[0]
        elif args.check:
            entry = catalog[0]
        else:
            packs = list({entry['packId']: {'id': entry['packId'], 'name': entry['pack']} for entry in catalog}.values())
            pack = choose(packs, 'Choose your pack')
            entry = choose([dict(item, name=item['title']) for item in catalog if item['packId'] == pack['id']], 'Choose one inspiration')
        workflow_path = ROOT / entry['file']
        graph = json.loads(workflow_path.read_text())
        workflow = {'name': entry['pack'] + ' / ' + entry['title'], 'graph': graph, 'mapping': entry['mapping']}
        photo_path = args.photo.expanduser().resolve()
        photo = photo_path.read_bytes()
        studio.photo_type(photo)
        width, height = studio.FORMATS[args.format]
        print('\nYour photo: ' + photo_path.name)
        print('Inspiration: ' + workflow['name'])
        print(f'Output: ONE image, {args.format}, {width} x {height}')
        print('Quality: original 40-step mode')
        if not args.check and not args.yes:
            answer = input('\nPress Enter to generate this one photo, or type q to quit: ').strip()
            if answer:
                print('No generation started.')
                return 0
        digest = hashlib.sha256(workflow_path.read_bytes() + photo + args.format.encode()).hexdigest()[:12]
        suffix = digest + ('-' + uuid.uuid4().hex[:8] if args.new else '')
        folder = args.output.expanduser().resolve() / entry['id'] / suffix
        if args.check:
            studio.run(workflow, photo, folder, args.format, True)
        else:
            with (ROOT / 'studio.lock').open('a') as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    raise RuntimeError('Another inspiration is already generating. Let it finish first.')
                studio.run(workflow, photo, folder, args.format)
        return 0
    except (KeyboardInterrupt, EOFError):
        print('\nStopped checking. Any submitted job stays in ComfyUI; repeat the same command to resume.')
        return 130
    except (OSError, ValueError, RuntimeError) as error:
        print('Test stopped: ' + str(error), file=sys.stderr)
        return 1

if __name__ == '__main__':
    sys.exit(main())
