import {join} from 'path';

import {TypeScriptParser} from '@react-native/codegen/lib/parsers/typescript/parser';

/**
 * P5 runs React Native's Codegen over `specs/NativeRadio.ts` to generate the
 * Kotlin and Objective-C++ interfaces. Codegen supports a strict subset of
 * TypeScript, and `pnpm typecheck` knows nothing about that subset — a spec
 * file can typecheck perfectly and still be unbuildable. This test runs the
 * exact parser Codegen uses, so the failure lands in this plan.
 */
/**
 * Codegen's `SchemaType` is a wide union (`ComponentSchema | NativeModuleSchema`)
 * whose type annotations are unions of a dozen shapes. Narrow once, at the
 * boundary, into the small structure this test actually asserts on.
 */
type ParsedTypeAnnotation = {
  type: string;
  name?: string;
  types?: Array<{value: string}>;
  elementType?: {type: string; name?: string};
};

type ParsedObjectAlias = {
  type: string;
  properties: Array<{
    name: string;
    optional: boolean;
    typeAnnotation: ParsedTypeAnnotation;
  }>;
};

type ParsedNativeRadioModule = {
  type: string;
  moduleName: string;
  aliasMap: Record<string, ParsedObjectAlias>;
  spec: {
    // Codegen calls them `methods`, not `properties` — verified against
    // @react-native/codegen@0.87.0, whose parsed `spec` has exactly the two
    // keys `methods` and `eventEmitters`.
    methods: Array<{name: string}>;
    eventEmitters: Array<{
      name: string;
      typeAnnotation: {typeAnnotation: {name: string}};
    }>;
  };
};

function parseNativeRadioSpec(): ParsedNativeRadioModule {
  const schema = new TypeScriptParser().parseFile(
    join(__dirname, '..', 'specs', 'NativeRadio.ts'),
  );
  const parsed = schema.modules.NativeRadio;

  if (parsed === undefined || parsed.type !== 'NativeModule') {
    throw new Error(
      'specs/NativeRadio.ts was not parsed as a Turbo Module named NativeRadio',
    );
  }

  return parsed as unknown as ParsedNativeRadioModule;
}

describe('specs/NativeRadio.ts is a valid Turbo Module spec', () => {
  const radioModule = parseNativeRadioSpec();

  it('is registered under the name both platforms must use', () => {
    expect(radioModule.moduleName).toBe('NativeRadio');
  });

  it('exposes exactly the amended section 6.1 methods', () => {
    expect(radioModule.spec.methods.map(method => method.name)).toEqual([
      'start',
      'stop',
      'pressPtt',
      'releasePtt',
      'getState',
      'configurePtt',
      'selectPttCandidate',
      'forgetPtt',
      'setAudioMode',
    ]);
  });

  it('exposes the stateChanged and error streams as typed event emitters', () => {
    expect(
      radioModule.spec.eventEmitters.map(emitter => [
        emitter.name,
        emitter.typeAnnotation.typeAnnotation.name,
      ]),
    ).toEqual([
      ['onStateChanged', 'NativeRadioState'],
      ['onError', 'NativeRadioErrorPayload'],
    ]);
  });

  it('keeps the radio status as a string-literal union Codegen can generate', () => {
    const status = radioModule.aliasMap.NativeRadioState.properties.find(
      property => property.name === 'status',
    );

    expect(status?.typeAnnotation.type).toBe('UnionTypeAnnotation');
    expect(status?.typeAnnotation.types?.map(member => member.value)).toEqual([
      'off',
      'starting',
      'ready',
      'error',
    ]);
  });

  it('keeps pttButton.name optional, as section 6.1 declares it', () => {
    const name = radioModule.aliasMap.NativePttButtonState.properties.find(
      property => property.name === 'name',
    );

    expect(name?.optional).toBe(true);
  });

  it('carries pairing progress as an optional field on the state, not a third emitter', () => {
    const pairing = radioModule.aliasMap.NativeRadioState.properties.find(
      property => property.name === 'pttPairing',
    );

    expect(pairing?.optional).toBe(true);
    expect(pairing?.typeAnnotation.name).toBe('NativePttPairingState');
    expect(radioModule.spec.eventEmitters).toHaveLength(2);
  });

  it('generates the pairing phase and candidate list Codegen can express', () => {
    const properties = radioModule.aliasMap.NativePttPairingState.properties;
    const phase = properties.find(property => property.name === 'phase');
    const candidates = properties.find(property => property.name === 'candidates');

    expect(phase?.typeAnnotation.type).toBe('UnionTypeAnnotation');
    expect(phase?.typeAnnotation.types?.map(member => member.value)).toEqual([
      'scanning',
      'learning',
      'saved',
    ]);

    expect(candidates?.typeAnnotation.type).toBe('ArrayTypeAnnotation');
    expect(candidates?.typeAnnotation.elementType?.name).toBe('NativePttCandidate');
    expect(
      radioModule.aliasMap.NativePttCandidate.properties.map(
        property => property.name,
      ),
    ).toEqual(['deviceId', 'name', 'rssi']);
  });

  it('keeps the PTT binding flat, because Codegen cannot express object unions', () => {
    const binding = radioModule.aliasMap.NativePttBinding;

    expect(binding.type).toBe('ObjectTypeAnnotation');
    expect(binding.properties.map(property => property.name)).toEqual([
      'type',
      'deviceId',
      'serviceUuid',
      'characteristicUuid',
      'pressedValue',
      'releasedValue',
      'keyCode',
    ]);
  });
});
