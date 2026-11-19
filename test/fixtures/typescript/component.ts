function Component(_metadata: object): ClassDecorator {
  return () => {};
}

@Component({ selector: 'fixture-component' })
export class FixtureComponent {
  load(): string {
    return 'loaded';
  }

  openCreate(): string {
    return this.load();
  }
}
