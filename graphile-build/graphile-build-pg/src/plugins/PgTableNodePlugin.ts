import "graphile-config";

import type {
  PgCodec,
  PgResource,
  PgResourceUnique,
  PgSelectSingleStep,
} from "@dataplan/pg";
import type { ListStep } from "grafast";
import { access, constant, list } from "grafast";
import { EXPORTABLE } from "graphile-build";
import te, { isSafeObjectPropertyName } from "tamedevil";

import { tagToString } from "../utils.js";
import { version } from "../version.js";

declare global {
  namespace GraphileBuild {
    interface SchemaOptions {
      pgV4UseTableNameForNodeIdentifier?: boolean;
    }
  }
}

export const PgTableNodePlugin: GraphileConfig.Plugin = {
  name: "PgTableNodePlugin",
  description: "Add the 'Node' interface to table types",
  version: version,
  after: ["PgTablesPlugin", "PgPolymorphismPlugin"],

  schema: {
    entityBehavior: {
      pgCodec: {
        provides: ["default"],
        before: ["inferred", "override"],
        callback(behavior, codec, build) {
          const newBehavior = [behavior];
          if (
            !codec.isAnonymous &&
            !!codec.attributes &&
            (!codec.polymorphism ||
              codec.polymorphism.mode === "single" ||
              codec.polymorphism.mode === "relational")
          ) {
            const resources = Object.values(
              build.input.pgRegistry.pgResources,
            ).filter((r) => {
              if (r.codec !== codec) return false;
              if (r.parameters) return false;
              if (r.isUnique) return false;
              if (r.isVirtual) return false;
              if (!r.uniques || r.uniques.length < 1) return false;
              return true;
            });
            if (resources.length === 1) {
              if (codec.polymorphism) {
                newBehavior.push("interface:node");
              } else {
                newBehavior.push("type:node");
              }
            } else if (resources.length > 1) {
              console.warn(
                `Found multiple table resources for codec '${codec.name}'; we don't currently support that but we _could_ - get in touch if you need this.`,
              );
            } else {
              // Meh
            }
          }
          return newBehavior;
        },
      },
    },
    hooks: {
      init(_, build) {
        if (!build.registerNodeIdHandler) {
          return _;
        }
        const tableResources = Object.values(
          build.input.pgRegistry.pgResources,
        ).filter((resource) => {
          // TODO: if (!resourceCanSupportNode(resource)) return false;

          // Needs the 'select' and 'node' behaviours for compatibility
          return (
            !resource.parameters &&
            !resource.isUnique &&
            !resource.isVirtual &&
            !!build.behavior.pgCodecMatches(resource.codec, "type:node") &&
            !!build.behavior.pgResourceMatches(resource, "resource:select")
          );
        });

        const resourcesByCodec = new Map<PgCodec, PgResource[]>();
        for (const resource of tableResources) {
          let list = resourcesByCodec.get(resource.codec);
          if (!list) {
            list = [];
            resourcesByCodec.set(resource.codec, list);
          }
          list.push(resource);
        }

        for (const [codec, resources] of resourcesByCodec.entries()) {
          const tableTypeName = build.inflection.tableType(codec);
          const meta = build.getTypeMetaByName(tableTypeName);
          if (!meta) {
            console.trace(
              `Attempted to register node handler for '${tableTypeName}' (codec=${codec.name}), but that type wasn't registered (yet)`,
            );
            continue;
          }
          if (meta.Constructor !== build.graphql.GraphQLObjectType) {
            // Must be an interface? Skip!
            continue;
          }
          if (resources.length !== 1) {
            console.warn(
              `Found multiple table resources for codec '${codec.name}'; we don't currently support that but we _could_ - get in touch if you need this.`,
            );
            continue;
          }
          const pgResource = resources[0];
          const primaryKey = (pgResource.uniques as PgResourceUnique[]).find(
            (u) => u.isPrimary === true,
          );
          if (!primaryKey) {
            continue;
          }
          const pk = primaryKey.attributes;

          const identifier =
            // Yes, this behaviour in V4 was ridiculous. Alas.
            build.options.pgV4UseTableNameForNodeIdentifier &&
            pgResource.extensions?.pg?.name
              ? build.inflection.pluralize(pgResource.extensions.pg.name)
              : tableTypeName;

          const clean =
            isSafeObjectPropertyName(identifier) &&
            pk.every((attributeName) =>
              isSafeObjectPropertyName(attributeName),
            );

          const firstSource = resources.find((s) => !s.parameters);

          build.registerNodeIdHandler({
            typeName: tableTypeName,
            codec: build.getNodeIdCodec!("base64JSON"),
            deprecationReason: tagToString(
              codec.extensions?.tags?.deprecation ??
                firstSource?.extensions?.tags?.deprecated,
            ),
            plan: clean
              ? // eslint-disable-next-line graphile-export/exhaustive-deps
                EXPORTABLE(
                  te.run`\
return function (list, constant) {
  return $record => list([constant(${te.lit(identifier)}, false), ${te.join(
                    pk.map(
                      (attributeName) =>
                        te`$record.get(${te.lit(attributeName)})`,
                    ),
                    ", ",
                  )}]);
}` as any,
                  [list, constant],
                )
              : EXPORTABLE(
                  (constant, identifier, list, pk) =>
                    ($record: PgSelectSingleStep) => {
                      return list([
                        constant(identifier, false),
                        ...pk.map((attribute) => $record.get(attribute)),
                      ]);
                    },
                  [constant, identifier, list, pk],
                ),
            getSpec: clean
              ? // eslint-disable-next-line graphile-export/exhaustive-deps
                EXPORTABLE(
                  te.run`\
return function (access) {
  return $list => ({ ${te.join(
    pk.map(
      (attributeName, index) =>
        te`${te.safeKeyOrThrow(attributeName)}: access($list, [${te.lit(
          index + 1,
        )}])`,
    ),
    ", ",
  )} });
}` as any,
                  [access],
                )
              : EXPORTABLE(
                  (access, pk) => ($list: ListStep<any[]>) => {
                    const spec = pk.reduce((memo, attribute, index) => {
                      memo[attribute] = access($list, [index + 1]);
                      return memo;
                    }, Object.create(null));
                    return spec;
                  },
                  [access, pk],
                ),
            get: EXPORTABLE(
              (pgResource) => (spec: any) => pgResource.get(spec),
              [pgResource],
            ),
            match: EXPORTABLE(
              (identifier) => (obj) => {
                return obj[0] === identifier;
              },
              [identifier],
            ),
          });
        }

        return _;
      },
    },
  },
};
