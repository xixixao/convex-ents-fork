import {
  DataModelFromSchemaDefinition,
  DefineSchemaOptions,
  GenericDataModel,
  GenericDocument,
  GenericTableIndexes,
  GenericTableSearchIndexes,
  GenericTableVectorIndexes,
  SchemaDefinition,
  SearchIndexConfig,
  TableDefinition,
  TableNamesInDataModel,
  defineSchema,
} from "convex/server";
import {
  GenericId,
  ObjectType,
  PropertyValidators,
  Validator,
  v,
} from "convex/values";

export function defineEntSchema<
  Schema extends Record<string, EntDefinition<any, any, any, any, any, any>>,
  StrictTableNameTypes extends boolean = true
>(
  schema: Schema,
  options?: DefineSchemaOptions<StrictTableNameTypes>
): SchemaDefinition<Schema, StrictTableNameTypes> {
  // If we have two ref edges pointing at each other,
  // we gotta add the table for them with indexes
  const tableNames = Object.keys(schema);
  for (const tableName of tableNames) {
    const table = schema[tableName];
    for (const edge of Object.values(
      (table as any).edgeConfigs as Record<string, EdgeConfigFromEntDefinition>
    )) {
      const otherTableName = edge.to;
      const otherTable = schema[otherTableName];
      if (otherTable === undefined) {
        continue;
      }

      const isSelfDirected = edge.to === tableName;

      const inverseEdgeCandidates = Object.values(
        (otherTable as any).edgeConfigs as Record<
          string,
          EdgeConfigFromEntDefinition
        >
      ).filter(
        (candidate) =>
          candidate.to === tableName &&
          candidate.name !== edge.name &&
          (!isSelfDirected || (candidate.type === null && candidate.inverse))
      );
      if (inverseEdgeCandidates.length > 1) {
        throw new Error(
          'Too many potential inverse edges for "' +
            edge.name +
            `", all eligible: ${inverseEdgeCandidates
              .map((edge) => `"${edge.name}"`)
              .join(", ")}`
        );
      }
      const inverseEdge: EdgeConfigFromEntDefinition | undefined =
        inverseEdgeCandidates[0];

      if (edge.cardinality === "single" && edge.type === "ref") {
        if (
          inverseEdge?.cardinality === "single" &&
          inverseEdge.type === "ref"
        ) {
          // TODO: If we want to support optional 1:1 edges in the future
          // throw new Error(
          //   `Both edge "${edge.name}" on ent "${inverseEdge.to}" and ` +
          //     `edge "${inverseEdge.name}" on ent "${edge.to}" are marked ` +
          //     `as optional, specify which table should store the 1:1 edge by ` +
          //     `providing a \`field\` name.`
          // );
          throw new Error(
            `Both edge "${edge.name}" in table "${inverseEdge.to}" and ` +
              `edge "${inverseEdge.name}" in table "${edge.to}" are marked ` +
              `as optional, choose one to be required.`
          );
        }
        if (
          inverseEdge?.cardinality !== "single" ||
          inverseEdge?.type !== "field"
        ) {
          throw new Error(
            `Unexpected inverse edge type ${edge.name}, ${inverseEdge?.name}`
          );
        }
        if (edge.ref !== null && edge.ref !== inverseEdge.field) {
          throw new Error(
            `The edge "${inverseEdge.name}" in table "${otherTableName}" ` +
              `must have its \`field\` option set to "${edge.ref}", ` +
              `to match the inverse edge "${edge.name}" in table "${inverseEdge.to}".`
          );
        }
        if (edge.ref === null) {
          (edge as any).ref = inverseEdge.field;
          (inverseEdge as any).unique = true;
        }
      }
      if (edge.cardinality === "multiple") {
        if (edge.type !== null) {
          continue;
        }

        if (inverseEdge?.cardinality === "single") {
          if (inverseEdge.type === "ref") {
            throw new Error(
              `The edge "${inverseEdge.name}" in table "${otherTable}" ` +
                `cannot be optional, as it must store the 1:many edge as a field. ` +
                `Check the its inverse edge "${edge.name}" in table "${inverseEdge.to}".`
            );
          }
          (edge as any).type = "field";
          (edge as any).ref = inverseEdge.field;
        }

        if (inverseEdge?.cardinality === "multiple" || isSelfDirected) {
          const edgeTableName =
            inverseEdge === undefined
              ? `${tableName}_${edge.name}`
              : inverseEdge.name !== tableName
              ? `${tableName}_${inverseEdge.name}_to_${edge.name}`
              : `${inverseEdge.name}_to_${edge.name}`;

          const forwardId =
            inverseEdge === undefined
              ? "aId"
              : tableName === otherTableName
              ? inverseEdge.name + "Id"
              : tableName + "Id";
          const inverseId =
            inverseEdge === undefined
              ? "bId"
              : tableName === otherTableName
              ? edge.name + "Id"
              : otherTableName + "Id";
          // Add the table
          (schema as any)[edgeTableName] = defineEnt({
            [forwardId]: v.id(tableName),
            [inverseId]: v.id(otherTableName),
          })
            .index(forwardId, [forwardId, inverseId])
            .index(inverseId, [inverseId, forwardId]);

          (edge as any).type = "ref";
          (edge as any).table = edgeTableName;
          (edge as any).field = forwardId;
          (edge as any).ref = inverseId;
          (edge as any).symmetric = inverseEdge === undefined;
          if (inverseEdge !== undefined) {
            inverseEdge.type = "ref";
            (inverseEdge as any).table = edgeTableName;
            (inverseEdge as any).field = inverseId;
            (inverseEdge as any).ref = forwardId;
          }
        }
      }
    }
  }
  return defineSchema(schema, options);
}

export function defineEnt<
  DocumentSchema extends Record<string, Validator<any, any, any>>
>(
  documentSchema: DocumentSchema
): EntDefinition<
  ExtractDocument<ObjectValidator<DocumentSchema>>,
  ExtractFieldPaths<ObjectValidator<DocumentSchema>>
> {
  return new EntDefinitionImpl(documentSchema) as any;
}

type GenericEdges = Record<string, GenericEdgeConfig>;

export type GenericEdgeConfig = {
  name: string;
  to: string;
  cardinality: "single" | "multiple";
  type: "field" | "ref";
};

interface EntDefinition<
  Document extends GenericDocument = GenericDocument,
  FieldPaths extends string = string,
  // eslint-disable-next-line @typescript-eslint/ban-types
  Indexes extends GenericTableIndexes = {},
  // eslint-disable-next-line @typescript-eslint/ban-types
  SearchIndexes extends GenericTableSearchIndexes = {},
  // eslint-disable-next-line @typescript-eslint/ban-types
  VectorIndexes extends GenericTableVectorIndexes = {},
  // eslint-disable-next-line @typescript-eslint/ban-types
  Edges extends GenericEdges = {}
> extends TableDefinition<
    Document,
    FieldPaths,
    Indexes,
    SearchIndexes,
    VectorIndexes
  > {
  /**
   * Define an index on this table.
   *
   * To learn about indexes, see [Defining Indexes](https://docs.convex.dev/using/indexes).
   *
   * @param name - The name of the index.
   * @param fields - The fields to index, in order. Must specify at least one
   * field.
   * @returns A {@link TableDefinition} with this index included.
   */
  index<
    IndexName extends string,
    FirstFieldPath extends FieldPaths,
    RestFieldPaths extends FieldPaths[]
  >(
    name: IndexName,
    fields: [FirstFieldPath, ...RestFieldPaths]
  ): EntDefinition<
    Document,
    FieldPaths,
    Expand<
      Indexes &
        Record<IndexName, [FirstFieldPath, ...RestFieldPaths, "_creationTime"]>
    >,
    SearchIndexes,
    VectorIndexes,
    Edges
  >;

  /**
   * Define a search index on this table.
   *
   * To learn about search indexes, see [Search](https://docs.convex.dev/text-search).
   *
   * @param name - The name of the index.
   * @param indexConfig - The search index configuration object.
   * @returns A {@link TableDefinition} with this search index included.
   */
  searchIndex<
    IndexName extends string,
    SearchField extends FieldPaths,
    FilterFields extends FieldPaths = never
  >(
    name: IndexName,
    indexConfig: Expand<SearchIndexConfig<SearchField, FilterFields>>
  ): EntDefinition<
    Document,
    FieldPaths,
    Indexes,
    Expand<
      SearchIndexes &
        Record<
          IndexName,
          {
            searchField: SearchField;
            filterFields: FilterFields;
          }
        >
    >,
    VectorIndexes,
    Edges
  >;

  // TODO: For some reason this breaks types,
  // even though I changed VectorIndexConfig to be exported
  // from convex/server
  // /**
  //  * Define a vector index on this table.
  //  *
  //  * To learn about vector indexes, see [Vector Search](https://docs.convex.dev/vector-search).
  //  *
  //  * @param name - The name of the index.
  //  * @param indexConfig - The vector index configuration object.
  //  * @returns A {@link TableDefinition} with this vector index included.
  //  */
  // vectorIndex<
  //   IndexName extends string,
  //   VectorField extends FieldPaths,
  //   FilterFields extends FieldPaths = never
  // >(
  //   name: IndexName,
  //   indexConfig: Expand<VectorIndexConfig<VectorField, FilterFields>>
  // ): EntDefinition<
  //   Document,
  //   FieldPaths,
  //   Indexes,
  //   SearchIndexes,
  //   Expand<
  //     VectorIndexes &
  //       Record<
  //         IndexName,
  //         {
  //           vectorField: VectorField;
  //           dimensions: number;
  //           filterFields: FilterFields;
  //         }
  //       >
  //   >,
  //   Edges
  // >;

  field<FieldName extends string, T extends Validator<any, any, any>>(
    field: FieldName,
    validator: T
  ): EntDefinition<
    Document & ObjectFieldType<FieldName, T>,
    FieldPaths | FieldName,
    Indexes,
    SearchIndexes,
    VectorIndexes,
    Edges
  >;
  field<FieldName extends string, T extends Validator<any, any, any>>(
    field: FieldName,
    validator: T,
    options: { index: true }
  ): EntDefinition<
    Document & ObjectFieldType<FieldName, T>,
    FieldPaths | FieldName,
    Indexes & { [key in FieldName]: [FieldName] },
    SearchIndexes,
    VectorIndexes,
    Edges
  >;
  field<FieldName extends string, T extends Validator<any, any, any>>(
    field: FieldName,
    validator: T,
    options: { unique: true }
  ): EntDefinition<
    Document & ObjectFieldType<FieldName, T>,
    FieldPaths | FieldName,
    Indexes & { [key in FieldName]: [FieldName] },
    SearchIndexes,
    VectorIndexes,
    Edges
  >;
  field<FieldName extends string, T extends Validator<any, false, any>>(
    field: FieldName,
    validator: T,
    options: { default: T["type"] }
  ): EntDefinition<
    Document & ObjectFieldType<FieldName, T>,
    FieldPaths | FieldName,
    Indexes,
    SearchIndexes,
    VectorIndexes,
    Edges
  >;

  edge<EdgeName extends string>(
    edge: EdgeName
  ): EntDefinition<
    Document & { [key in `${EdgeName}Id`]: GenericId<`${EdgeName}s`> },
    FieldPaths | `${EdgeName}Id`,
    Indexes & { [key in `${EdgeName}Id`]: [`${EdgeName}Id`] },
    SearchIndexes,
    VectorIndexes,
    Edges & {
      [key in EdgeName]: {
        name: EdgeName;
        to: `${EdgeName}s`;
        type: "field";
        cardinality: "single";
      };
    }
  >;
  edge<EdgeName extends string, const FieldName extends string>(
    edge: EdgeName,
    options: { field: FieldName }
  ): EntDefinition<
    Document & { [key in FieldName]: GenericId<`${EdgeName}s`> },
    FieldPaths | FieldName,
    Indexes & { [key in FieldName]: [FieldName] },
    SearchIndexes,
    VectorIndexes,
    Edges & {
      [key in EdgeName]: {
        name: EdgeName;
        to: `${EdgeName}s`;
        type: "field";
        cardinality: "single";
      };
    }
  >;
  edge<EdgeName extends string>(
    edge: EdgeName,
    options: { optional: true; ref?: string }
  ): EntDefinition<
    Document,
    FieldPaths,
    Indexes,
    SearchIndexes,
    VectorIndexes,
    Edges & {
      [key in EdgeName]: {
        name: EdgeName;
        to: `${EdgeName}s`;
        type: "ref";
        cardinality: "single";
      };
    }
  >;

  edges<EdgesName extends string>(
    edge: EdgesName
  ): EntDefinition<
    Document,
    FieldPaths,
    Indexes,
    SearchIndexes,
    VectorIndexes,
    Edges & {
      [key in EdgesName]: {
        name: EdgesName;
        to: EdgesName;
        type: "ref";
        cardinality: "multiple";
      };
    }
  >;
  edges<EdgesName extends string, TableName extends string>(
    edge: EdgesName,
    options: { to: TableName }
  ): EntDefinition<
    Document,
    FieldPaths,
    Indexes,
    SearchIndexes,
    VectorIndexes,
    Edges & {
      [key in EdgesName]: {
        name: EdgesName;
        to: TableName;
        type: "ref";
        cardinality: "multiple";
      };
    }
  >;
  edges<
    EdgesName extends string,
    TableName extends string,
    InverseEdgesNames extends string
  >(
    edge: EdgesName,
    options: { to: TableName; inverse: InverseEdgesNames }
  ): EntDefinition<
    Document,
    FieldPaths,
    Indexes,
    SearchIndexes,
    VectorIndexes,
    Edges & {
      [key in EdgesName]: {
        name: EdgesName;
        to: TableName;
        type: "ref";
        cardinality: "multiple";
      };
    } & {
      [key in InverseEdgesNames]: {
        name: InverseEdgesNames;
        to: TableName;
        type: "ref";
        cardinality: "multiple";
      };
    }
  >;
  edges(table: string, options: EdgesOptions): this;
}

type FieldOptions = {
  index?: true;
  unique?: true;
  default?: any;
};

type EdgeOptions = {
  optional?: true;
  field?: string;
  ref?: string;
};

type EdgesOptions = {
  to?: string;
  inverse?: string;
};

class EntDefinitionImpl {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  private indexes: Index[] = [];
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  private searchIndexes: SearchIndex[] = [];
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  private vectorIndexes: VectorIndex[] = [];

  private documentSchema: Record<string, Validator<any, any, any>>;

  private edgeConfigs: Record<string, EdgeConfigFromEntDefinition> = {};

  private fieldConfigs: Record<string, FieldConfig> = {};

  private defaults: Record<string, any> = {};

  constructor(documentSchema: Record<string, Validator<any, any, any>>) {
    this.documentSchema = documentSchema;
  }

  index(name: any, fields: any) {
    this.indexes.push({ indexDescriptor: name, fields });
    return this;
  }

  searchIndex(name: any, indexConfig: any) {
    this.searchIndexes.push({
      indexDescriptor: name,
      searchField: indexConfig.searchField,
      filterFields: indexConfig.filterFields || [],
    });
    return this;
  }

  vectorIndex(name: any, indexConfig: any) {
    this.vectorIndexes.push({
      indexDescriptor: name,
      vectorField: indexConfig.vectorField,
      dimensions: indexConfig.dimensions,
      filterFields: indexConfig.filterFields || [],
    });
    return this;
  }

  /**
   * Export the contents of this definition.
   *
   * This is called internally by the Convex framework.
   * @internal
   */
  export() {
    return {
      indexes: this.indexes,
      searchIndexes: this.searchIndexes,
      vectorIndexes: this.vectorIndexes,
      documentType: (v.object(this.documentSchema) as any).json,
    };
  }

  field(name: string, validator: any, options?: FieldOptions): this {
    if (this.documentSchema[name] !== undefined) {
      // TODO: Store the fieldConfigs in an array so that we can
      // do the uniqueness check in defineEntSchema where we
      // know the table name.
      throw new Error(`Duplicate field "${name}"`);
    }
    const finalValidator =
      options?.default !== undefined ? v.optional(validator) : validator;
    this.documentSchema = { ...this.documentSchema, [name]: finalValidator };
    if (options?.unique === true || options?.index === true) {
      this.indexes.push({ indexDescriptor: name, fields: [name] });
    }
    if (options?.default !== undefined) {
      this.defaults[name] = options.default;
    }
    if (options?.unique === true) {
      this.fieldConfigs[name] = { name, unique: true };
    }
    return this;
  }

  edge(edgeName: string, options?: EdgeOptions): this {
    if (this.edgeConfigs[edgeName] !== undefined) {
      // TODO: Store the edgeConfigs in an array so that we can
      // do the uniqueness check in defineEntSchema where we
      // know the source table name.
      throw new Error(`Duplicate edge "${edgeName}"`);
    }
    if (options?.optional !== true) {
      const to = edgeName + "s";
      const fieldName = options?.field ?? edgeName + "Id";
      this.documentSchema = { ...this.documentSchema, [fieldName]: v.id(to) };
      this.edgeConfigs[edgeName] = {
        name: edgeName,
        to,
        cardinality: "single",
        type: "field",
        field: fieldName,
      };
      this.indexes.push({
        indexDescriptor: fieldName,
        fields: [fieldName],
      });
      return this;
    }
    if (options.optional === true) {
      this.edgeConfigs[edgeName] = {
        name: edgeName,
        to: edgeName + "s",
        cardinality: "single",
        type: "ref",
        ref: options.ref ?? null,
      };
    }
    return this;
  }

  edges(name: string, options?: EdgesOptions): this {
    this.edgeConfigs[name] = {
      name: name,
      to: options?.to ?? name,
      cardinality: "multiple",
      type: null, // gets filled in by defineEntSchema
    };
    if (typeof options?.inverse === "string") {
      this.edgeConfigs[options?.inverse] = {
        name: options?.inverse,
        to: options?.to ?? name,
        cardinality: "multiple",
        type: null, // gets filled in by defineEntSchema
        inverse: true,
      };
    }
    return this;
  }
}

type ObjectFieldType<
  FieldName extends string,
  T extends Validator<any, any, any>
> = T["isOptional"] extends true
  ? { [key in FieldName]?: T["type"] }
  : { [key in FieldName]: T["type"] };

export type EdgeConfig = {
  name: string;
  to: string;
} & (
  | ({
      cardinality: "single";
    } & (
      | {
          type: "field";
          field: string;
          unique: boolean;
        }
      | { type: "ref"; ref: string }
    ))
  | ({
      cardinality: "multiple";
    } & (
      | { type: "field"; ref: string }
      | {
          type: "ref";
          table: string;
          field: string;
          ref: string;
          inverse: boolean;
          symmetric: boolean;
        }
    ))
);

type EdgeConfigFromEntDefinition = {
  name: string;
  to: string;
} & (
  | ({
      cardinality: "single";
    } & (
      | {
          type: "field";
          field: string;
        }
      | { type: "ref"; ref: null | string }
    ))
  | ({
      cardinality: "multiple";
    } & (
      | { type: null; inverse?: true }
      | { type: "field"; ref: string }
      | {
          type: "ref";
          table: string;
          field: string;
          ref: string;
          inverse?: true;
        }
    ))
);

export type FieldConfig = {
  name: string;
  unique: boolean;
};

type ExtractDocument<T extends Validator<any, any, any>> =
  // Add the system fields to `Value` (except `_id` because it depends on
  //the table name) and trick TypeScript into expanding them.
  Expand<SystemFields & T["type"]>;

export type Expand<ObjectType extends Record<any, any>> =
  ObjectType extends Record<any, any>
    ? {
        [Key in keyof ObjectType]: ObjectType[Key];
      }
    : never;
type ExtractFieldPaths<T extends Validator<any, any, any>> =
  // Add in the system fields available in index definitions.
  // This should be everything except for `_id` because thats added to indexes
  // automatically.
  T["fieldPaths"] | keyof SystemFields;
export type SystemFields = {
  _creationTime: number;
};

type ObjectValidator<Validators extends PropertyValidators> = Validator<
  // Compute the TypeScript type this validator refers to.
  ObjectType<Validators>,
  false,
  // Compute the field paths for this validator. For every property in the object,
  // add on a field path for that property and extend all the field paths in the
  // validator.
  {
    [Property in keyof Validators]:
      | JoinFieldPaths<Property & string, Validators[Property]["fieldPaths"]>
      | Property;
  }[keyof Validators] &
    string
>;

type JoinFieldPaths<
  Start extends string,
  End extends string
> = `${Start}.${End}`;

export type GenericEntsDataModel = GenericDataModel &
  Record<string, GenericEntModel>;

export type GenericEntModel = {
  edges: Record<string, GenericEdgeConfig>;
};

export type EntDataModelFromSchema<
  SchemaDef extends SchemaDefinition<any, boolean>
> = DataModelFromSchemaDefinition<SchemaDef> & {
  [TableName in keyof SchemaDef["tables"] &
    string]: SchemaDef["tables"][TableName] extends EntDefinition<
    any,
    any,
    any,
    any,
    any,
    infer Edges
  >
    ? {
        edges: Edges;
      }
    : never;
};

export function getEntDefinitions<
  SchemaDef extends SchemaDefinition<any, boolean>
>(schema: SchemaDef): EntDataModelFromSchema<typeof schema> {
  const tables = schema.tables;
  return Object.keys(tables).reduce(
    (acc, tableName) => ({
      ...acc,
      [tableName]: {
        defaults: tables[tableName].defaults,
        edges: tables[tableName].edgeConfigs,
        fields: tables[tableName].fieldConfigs,
      },
    }),
    {}
  ) as any;
}
