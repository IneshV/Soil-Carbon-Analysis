/************************************************************
 OBSERVATION-ALIGNED POINT COVARIATE STACK (250 M)
 ------------------------------------------------------------
 Covariate cutoff date: controlled by OBS_DATE_STR. Only input rows whose
 covariate_cutoff_date equals that value are sampled. Every dynamic window
 ends before the cutoff date (Earth Engine filterDate end dates are exclusive).

 Google Cloud Storage destination:
   Bucket: conus_grid_covariates
   Folder: RaCA_grid

 The extraction date is automatically included in:
   - Export task description
   - GeoTIFF filename prefix
   - LRR lookup-table filename
   - Image metadata

 To rerun for another date, change only:
   var OBS_DATE_STR = '2012-07-01';

 Newly included predictors:
   - NLCD_name
   - LU_scraped
   - MLRA_ID
   - LRR_group
   - ET_beta0
   - ET_a1
   - ET_b1
   - ET_a2
   - ET_b2
   - ET_trend

 Encoding notes:
   - Earth Engine image bands cannot store string values.
   - NLCD_name stores the numeric NLCD class code.
   - LU_scraped uses:
       1 = C: cropland
       2 = F: forest
       3 = R: rangeland, grassland, or shrubland
       4 = X: other
   - LRR_group is stored as a numeric index.
   - The LRR lookup table is exported alongside the raster.

 Required Code Editor imports:
   - table: uploaded raca_gee_points.csv or dsp4sh_gee_points.csv. The script rebuilds
     point geometry from its numeric lon and lat properties.
   - mlra: MLRA polygon FeatureCollection containing MLRA_ID
     and an LRR-related field such as LRR, LRR_NAME,
     LRR_CODE, REGION, or LRR_group.
************************************************************/


// ============================================================
// 0) GLOBAL CONFIGURATION
// ============================================================

// Change this date when generating a new extraction.
var OBS_DATE_STR = '2021-07-01';

var OBS_DATE = ee.Date(OBS_DATE_STR);
var OBS_YEAR = ee.Number.parse(
  OBS_DATE.format('YYYY')
);

// Safe date string for task descriptions and filenames.
var OBS_DATE_TAG = OBS_DATE_STR.replace(/-/g, '_');

// Google Cloud Storage destination.
var GCS_BUCKET = 'conus_grid_covariates';
var GCS_FOLDER = 'RaCA_grid';

// Output names automatically include the extraction date.
var EXPORT_BASENAME =
  'MASTER_CONUS_covariates_250m_' + OBS_DATE_TAG;

var IMAGE_EXPORT_DESCRIPTION =
  'MASTER_CONUS_covariates_250m_' +
  OBS_DATE_TAG +
  '_GCS';

var LRR_EXPORT_DESCRIPTION =
  'LRR_group_encoding_' +
  OBS_DATE_TAG +
  '_GCS';

var SCALE_EXPORT = 250;

// Point-table export settings.
var INPUT_DATASET_NAME = 'dsp4sh'; // Change to 'raca' for raca_gee_points.csv.
var POINT_EXPORT_FOLDER = 'unique_point_covariates';
var POINT_EXPORT_BASENAME =
  INPUT_DATASET_NAME + '_ALL_covariates_unique_points_' + OBS_DATE_TAG;
var POINT_EXPORT_DESCRIPTION =
  INPUT_DATASET_NAME + '_ALL_covariates_unique_points_' + OBS_DATE_TAG + '_Drive';
var NODATA_VALUE = -9999;
var DATE_PROPERTY = 'covariate_cutoff_date';

// Rebuild point geometry explicitly from the CSV columns. This works even
// when the uploaded table was not assigned geometry during asset ingestion.
var allInputRows = ee.FeatureCollection(table);
var inputPoints = allInputRows
  .filter(ee.Filter.eq(DATE_PROPERTY, OBS_DATE_STR))
  .distinct(['gee_point_id'])
  .map(function(feature) {
  feature = ee.Feature(feature);
  var lon = ee.Number.parse(ee.String(feature.get('lon')));
  var lat = ee.Number.parse(ee.String(feature.get('lat')));
  return feature.setGeometry(ee.Geometry.Point([lon, lat]));
  });

print('All uploaded point/date rows:', allInputRows.size());
print('Rows selected for cutoff ' + OBS_DATE_STR + ':', inputPoints.size());
print('First input point:', inputPoints.first());
Map.addLayer(inputPoints, {color: 'yellow'}, 'Unique input points', false);

// Export tiles. Earth Engine may create multiple GeoTIFFs.
var FILE_DIMENSIONS = 4096;

// Temporal windows.
var ONE_YEAR_START = OBS_DATE.advance(-1, 'year');
var FIVE_YEAR_START = OBS_DATE.advance(-5, 'year');
var TEN_YEAR_START = OBS_DATE.advance(-10, 'year');

// Complete ten-year calendar window ending January 1 of
// the extraction year.
var CLIM10_START = ee.Date.fromYMD(
  OBS_YEAR.subtract(10),
  1,
  1
);

var CLIM10_END = ee.Date.fromYMD(
  OBS_YEAR,
  1,
  1
);

// Spring window for Tmin_spring_min.
var CURRENT_SPRING_END = ee.Date.fromYMD(OBS_YEAR, 6, 1);
var SPRING_YEAR = ee.Number(ee.Algorithms.If(
  OBS_DATE.millis().gte(CURRENT_SPRING_END.millis()),
  OBS_YEAR,
  OBS_YEAR.subtract(1)
));

var SPRING_START = ee.Date.fromYMD(
  SPRING_YEAR,
  3,
  1
);

var SPRING_END = ee.Date.fromYMD(
  SPRING_YEAR,
  6,
  1
);

print('Observation/extraction date:', OBS_DATE);
print('Observation year:', OBS_YEAR);
print('Output basename:', EXPORT_BASENAME);
print('GCS bucket:', GCS_BUCKET);
print('GCS folder:', GCS_FOLDER);
print('One-year window:', ONE_YEAR_START, OBS_DATE);
print('Five-year window:', FIVE_YEAR_START, OBS_DATE);
print('Ten-year window:', TEN_YEAR_START, OBS_DATE);
print(
  'Ten-year climate functional window:',
  CLIM10_START,
  CLIM10_END
);


// ============================================================
// 1) CONUS GEOMETRY
// ============================================================

var states = ee.FeatureCollection(
  'TIGER/2018/States'
).filter(
  ee.Filter.inList(
    'STUSPS',
    [
      'AL', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL',
      'GA', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA',
      'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT',
      'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND',
      'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN',
      'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'
    ]
  )
);

var CONUS = states.union().geometry();

Map.centerObject(CONUS, 4);

Map.addLayer(
  CONUS,
  {},
  'CONUS',
  false
);


// ============================================================
// 2) GENERAL HELPER FUNCTIONS
// ============================================================

function emptyBand(name) {
  return ee.Image.constant(0)
    .rename(name)
    .updateMask(
      ee.Image.constant(0)
    );
}


function safeMean(
  imageCollection,
  bandName,
  outputName
) {
  imageCollection = ee.ImageCollection(
    imageCollection
  );

  return ee.Image(
    ee.Algorithms.If(
      imageCollection.size().gt(0),

      imageCollection
        .select(bandName)
        .mean()
        .rename(outputName),

      emptyBand(outputName)
    )
  );
}


function safeSum(
  imageCollection,
  bandName,
  outputName
) {
  imageCollection = ee.ImageCollection(
    imageCollection
  );

  return ee.Image(
    ee.Algorithms.If(
      imageCollection.size().gt(0),

      imageCollection
        .select(bandName)
        .sum()
        .rename(outputName),

      emptyBand(outputName)
    )
  );
}


function statsFromCollection(
  imageCollection,
  bandName,
  prefix
) {
  imageCollection = ee.ImageCollection(
    imageCollection
  ).select(bandName);

  var meanImage = ee.Image(
    ee.Algorithms.If(
      imageCollection.size().gt(0),

      imageCollection
        .mean()
        .rename(prefix + '_mean'),

      emptyBand(prefix + '_mean')
    )
  );

  var p25Image = ee.Image(
    ee.Algorithms.If(
      imageCollection.size().gt(0),

      imageCollection
        .reduce(
          ee.Reducer.percentile([25])
        )
        .rename(prefix + '_p25'),

      emptyBand(prefix + '_p25')
    )
  );

  var p75Image = ee.Image(
    ee.Algorithms.If(
      imageCollection.size().gt(0),

      imageCollection
        .reduce(
          ee.Reducer.percentile([75])
        )
        .rename(prefix + '_p75'),

      emptyBand(prefix + '_p75')
    )
  );

  var iqrImage = p75Image
    .subtract(p25Image)
    .rename(prefix + '_IQR');

  return meanImage
    .addBands(p25Image)
    .addBands(p75Image)
    .addBands(iqrImage);
}


function firstExistingPropertyName(
  feature,
  candidates
) {
  feature = ee.Feature(feature);
  candidates = ee.List(candidates);

  var propertyNames = feature.propertyNames();

  return ee.String(
    candidates.iterate(
      function(candidate, currentValue) {
        candidate = ee.String(candidate);
        currentValue = ee.String(currentValue);

        return ee.Algorithms.If(
          currentValue.length().gt(0),

          currentValue,

          ee.Algorithms.If(
            propertyNames.contains(candidate),
            candidate,
            currentValue
          )
        );
      },
      ee.String('')
    )
  );
}


// ============================================================
// 3) GENERAL SECOND-ORDER HARMONIC FUNCTIONS
// ============================================================

function addHarmonicAmplitudePhase(coefficients, prefix) {
  coefficients = ee.Image(coefficients);

  var amp1 = coefficients
    .select(prefix + '_a1').pow(2)
    .add(coefficients.select(prefix + '_b1').pow(2))
    .sqrt()
    .rename(prefix + '_amp1');

  var phase1 = coefficients
    .select(prefix + '_b1').multiply(-1)
    .atan2(coefficients.select(prefix + '_a1'))
    .rename(prefix + '_phase1');

  var amp2 = coefficients
    .select(prefix + '_a2').pow(2)
    .add(coefficients.select(prefix + '_b2').pow(2))
    .sqrt()
    .rename(prefix + '_amp2');

  var phase2 = coefficients
    .select(prefix + '_b2').multiply(-1)
    .atan2(coefficients.select(prefix + '_a2'))
    .rename(prefix + '_phase2');

  return coefficients.addBands([
    amp1,
    phase1,
    amp2,
    phase2
  ]);
}

function addTimeBandsWindowed(
  image,
  startDate,
  bandName
) {
  image = ee.Image(image);
  startDate = ee.Date(startDate);

  var imageDate = ee.Date(
    image.get('system:time_start')
  );

  var tYears = ee.Number(
    imageDate.difference(
      startDate,
      'year'
    )
  );

  var base = ee.Image.constant(0)
    .toFloat();

  var tImage = base
    .add(tYears)
    .rename('t');

  var twoPi = ee.Number(2)
    .multiply(Math.PI);

  var cos1 = tImage
    .multiply(twoPi)
    .cos()
    .rename('cos1');

  var sin1 = tImage
    .multiply(twoPi)
    .sin()
    .rename('sin1');

  var cos2 = tImage
    .multiply(twoPi.multiply(2))
    .cos()
    .rename('cos2');

  var sin2 = tImage
    .multiply(twoPi.multiply(2))
    .sin()
    .rename('sin2');

  var constant = base
    .add(1)
    .rename('constant');

  return image
    .select([bandName])
    .toFloat()
    .addBands([
      constant,
      cos1,
      sin1,
      cos2,
      sin2,
      tImage
    ])
    .copyProperties(
      image,
      ['system:time_start']
    );
}


function buildHarmCoeffs(
  imageCollection,
  bandName,
  startDate,
  endDate,
  outputPrefix
) {
  startDate = ee.Date(startDate);
  endDate = ee.Date(endDate);

  var collection = ee.ImageCollection(
    imageCollection
  )
    .filterDate(
      startDate,
      endDate
    )
    .select(bandName)
    .map(function(image) {
      return addTimeBandsWindowed(
        image,
        startDate,
        bandName
      );
    });

  var outputNames = [
    outputPrefix + '_beta0',
    outputPrefix + '_a1',
    outputPrefix + '_b1',
    outputPrefix + '_a2',
    outputPrefix + '_b2',
    outputPrefix + '_trend'
  ];

  var empty = ee.Image.constant([
    0,
    0,
    0,
    0,
    0,
    0
  ])
    .rename(outputNames)
    .updateMask(
      ee.Image.constant(0)
    );

  var coefficients = ee.Image(
    ee.Algorithms.If(
      collection.size().lt(10),

      empty,

      (function() {
        var regression = collection
          .select([
            'constant',
            'cos1',
            'sin1',
            'cos2',
            'sin2',
            't',
            bandName
          ])
          .reduce(
            ee.Reducer.linearRegression({
              numX: 6,
              numY: 1
            })
          );

        return regression
          .select('coefficients')
          .arrayProject([0])
          .arrayFlatten([
            outputNames
          ]);
      })()
    )
  );

  return addHarmonicAmplitudePhase(
    coefficients,
    outputPrefix
  );
}


// ============================================================
// 4) EVI SECOND-ORDER HARMONIC FUNCTIONS
// ============================================================

function addTimeBandsEVI2Harm(
  image,
  startDate
) {
  image = ee.Image(image);
  startDate = ee.Date(startDate);

  var imageDate = ee.Date(
    image.get('system:time_start')
  );

  var tYears = ee.Number(
    imageDate.difference(
      startDate,
      'year'
    )
  );

  var base = ee.Image.constant(0)
    .toFloat();

  var tImage = base
    .add(tYears)
    .rename('t');

  var twoPi = ee.Number(2)
    .multiply(Math.PI);

  var angle1 = tImage.multiply(twoPi);
  var angle2 = tImage.multiply(
    twoPi.multiply(2)
  );

  var constant = base
    .add(1)
    .rename('constant');

  var cos1 = angle1
    .cos()
    .rename('cos1');

  var sin1 = angle1
    .sin()
    .rename('sin1');

  var cos2 = angle2
    .cos()
    .rename('cos2');

  var sin2 = angle2
    .sin()
    .rename('sin2');

  return image
    .select('EVI')
    .toFloat()
    .addBands([
      constant,
      cos1,
      sin1,
      cos2,
      sin2,
      tImage
    ])
    .copyProperties(
      image,
      ['system:time_start']
    );
}


function buildEVI2HarmCoeffs(
  startDate,
  endDate
) {
  startDate = ee.Date(startDate);
  endDate = ee.Date(endDate);

  var eviCollection = ee.ImageCollection(
    'MODIS/061/MOD13Q1'
  )
    .filterDate(
      startDate,
      endDate
    )
    .map(maskMOD13)
    .map(function(image) {
      return image
        .select('EVI')
        .multiply(0.0001)
        .rename('EVI')
        .copyProperties(
          image,
          ['system:time_start']
        );
    })
    .map(function(image) {
      return addTimeBandsEVI2Harm(
        image,
        startDate
      );
    });

  var outputNames = [
    'EVI_beta0',
    'EVI_a1',
    'EVI_b1',
    'EVI_a2',
    'EVI_b2',
    'EVI_trend'
  ];

  var empty = ee.Image.constant([
    0,
    0,
    0,
    0,
    0,
    0
  ])
    .rename(outputNames)
    .updateMask(
      ee.Image.constant(0)
    );

  var coefficients = ee.Image(
    ee.Algorithms.If(
      eviCollection.size().lt(10),

      empty,

      (function() {
        var regression = eviCollection
          .select([
            'constant',
            'cos1',
            'sin1',
            'cos2',
            'sin2',
            't',
            'EVI'
          ])
          .reduce(
            ee.Reducer.linearRegression({
              numX: 6,
              numY: 1
            })
          );

        return regression
          .select('coefficients')
          .arrayProject([0])
          .arrayFlatten([
            outputNames
          ]);
      })()
    )
  );

  return addHarmonicAmplitudePhase(
    coefficients,
    'EVI'
  );
}


// ============================================================
// 5) ET SECOND-ORDER HARMONIC FUNCTIONS
// ============================================================

function prepareMOD16ET(image) {
  image = ee.Image(image);

  var etRaw = image.select('ET');

  var hasQC = image
    .bandNames()
    .contains('ET_QC');

  var qcMask = ee.Image(
    ee.Algorithms.If(
      hasQC,

      image
        .select('ET_QC')
        .eq(0),

      ee.Image.constant(1)
    )
  );

  return etRaw
    .updateMask(qcMask)
    .multiply(0.1)
    .rename('ET')
    .copyProperties(
      image,
      ['system:time_start']
    );
}


function addTimeBandsET2Harm(
  image,
  startDate
) {
  image = ee.Image(image);
  startDate = ee.Date(startDate);

  var imageDate = ee.Date(
    image.get('system:time_start')
  );

  var tYears = ee.Number(
    imageDate.difference(
      startDate,
      'year'
    )
  );

  var base = ee.Image.constant(0)
    .toFloat();

  var tImage = base
    .add(tYears)
    .rename('t');

  var constant = base
    .add(1)
    .rename('constant');

  var twoPi = ee.Number(2)
    .multiply(Math.PI);

  var angle1 = tImage.multiply(twoPi);
  var angle2 = tImage.multiply(
    twoPi.multiply(2)
  );

  var cos1 = angle1
    .cos()
    .rename('cos1');

  var sin1 = angle1
    .sin()
    .rename('sin1');

  var cos2 = angle2
    .cos()
    .rename('cos2');

  var sin2 = angle2
    .sin()
    .rename('sin2');

  return image
    .select('ET')
    .toFloat()
    .addBands([
      constant,
      cos1,
      sin1,
      cos2,
      sin2,
      tImage
    ])
    .copyProperties(
      image,
      ['system:time_start']
    );
}


function buildET2HarmCoeffs(
  etCollection,
  startDate,
  endDate
) {
  startDate = ee.Date(startDate);
  endDate = ee.Date(endDate);

  var collection = ee.ImageCollection(
    etCollection
  )
    .filterDate(
      startDate,
      endDate
    )
    .select('ET')
    .map(function(image) {
      return addTimeBandsET2Harm(
        image,
        startDate
      );
    });

  var imageCount = collection.size();

  var outputNames = [
    'ET_beta0',
    'ET_a1',
    'ET_b1',
    'ET_a2',
    'ET_b2',
    'ET_trend'
  ];

  var empty = ee.Image.constant([
    0,
    0,
    0,
    0,
    0,
    0
  ])
    .rename(outputNames)
    .updateMask(
      ee.Image.constant(0)
    )
    .set(
      'ET_harmonic_n_images',
      imageCount
    );

  var coefficients = ee.Image(
    ee.Algorithms.If(
      imageCount.lt(10),

      empty,

      (function() {
        var regression = collection
          .select([
            'constant',
            'cos1',
            'sin1',
            'cos2',
            'sin2',
            't',
            'ET'
          ])
          .reduce(
            ee.Reducer.linearRegression({
              numX: 6,
              numY: 1
            })
          );

        return regression
          .select('coefficients')
          .arrayProject([0])
          .arrayFlatten([
            outputNames
          ])
          .set({
            ET_harmonic_window_start:
              startDate.millis(),

            ET_harmonic_window_end:
              endDate.millis(),

            ET_harmonic_n_images:
              imageCount,

            ET_harmonic_order:
              2
          });
      })()
    )
  );

  return addHarmonicAmplitudePhase(
    coefficients,
    'ET'
  );
}


// ============================================================
// 6) STATIC TOPOGRAPHY, HYDROLOGY, AND ARIDITY
// ============================================================

var merit = ee.Image(
  'MERIT/Hydro/v1_0_1'
);

var elvMerit = merit
  .select('elv')
  .rename('EL_MERIT');

var hand = merit
  .select('hnd')
  .rename('HAND');

var upstreamArea = merit.select('upa');

var slopeDegreesMerit = ee.Terrain.slope(
  elvMerit
);

var slopeRadiansMerit = slopeDegreesMerit
  .multiply(Math.PI / 180);

var slopeRadiansSafe = slopeRadiansMerit
  .where(
    slopeRadiansMerit.lt(0.001),
    0.001
  );

var twi = upstreamArea
  .add(1)
  .divide(
    slopeRadiansSafe.tan()
  )
  .log()
  .rename('TWI');

var terrain = ee.Terrain.products(
  elvMerit
).select(
  ['slope', 'aspect'],
  ['SL', 'ASPECT']
);

var aridityIndex = ee.Image(
  'projects/sat-io/open-datasets/global_ai/global_ai_yearly'
)
  .divide(10000)
  .rename('AI');

var topoStack = ee.Image.cat([
  elvMerit,
  terrain,
  twi,
  hand,
  aridityIndex
]);

print(
  'Topography/static bands:',
  topoStack.bandNames()
);


// ============================================================
// 7) STATIC SOIL, GEOLOGY, AND LAND COVER
// ============================================================

// Choose the latest NLCD release that does not occur after the cutoff date.
var NLCD_YEAR = ee.Number(
  ee.Algorithms.If(
    OBS_YEAR.lt(2006),
    2001,

    ee.Algorithms.If(
      OBS_YEAR.lt(2011),
      2006,

      ee.Algorithms.If(
        OBS_YEAR.lt(2016),
        2011,

        ee.Algorithms.If(
          OBS_YEAR.lt(2019),
          2016,
          2019
        )
      )
    )
  )
);

print('NLCD year selected:', NLCD_YEAR);

var nlcdImage = ee.ImageCollection(
  'USGS/NLCD_RELEASES/2019_REL/NLCD'
)
  .filter(
    ee.Filter.eq(
      'system:index',
      NLCD_YEAR.format('%d')
    )
  )
  .first()
  .select('landcover')
  .rename('LULC');

// Earth Engine image bands cannot store class-name strings.
// NLCD_name stores the numeric NLCD code.
var nlcdName = nlcdImage
  .rename('NLCD_name')
  .toInt16();

// Compact land-use encoding:
//   1 = C: cropland
//   2 = F: forest
//   3 = R: rangeland, grassland, shrubland
//   4 = X: other
var luScraped = ee.Image.constant(4)
  .where(
    nlcdImage
      .eq(81)
      .or(
        nlcdImage.eq(82)
      ),
    1
  )
  .where(
    nlcdImage
      .gte(41)
      .and(
        nlcdImage.lte(43)
      ),
    2
  )
  .where(
    nlcdImage
      .eq(52)
      .or(
        nlcdImage.eq(71)
      ),
    3
  )
  .rename('LU_scraped')
  .toInt16()
  .updateMask(
    nlcdImage.mask()
  );

var textureClass = ee.Image(
  'OpenLandMap/SOL/SOL_TEXTURE-CLASS_USDA-TT_M/v02'
)
  .select('b0')
  .rename('SOIL_TEXTURE');

var clayPct = ee.Image(
  'OpenLandMap/SOL/SOL_CLAY-WFRACTION_USDA-3A1A1A_M/v02'
)
  .select('b0')
  .rename('clay_pct');

var sandPct = ee.Image(
  'OpenLandMap/SOL/SOL_SAND-WFRACTION_USDA-3A1A1A_M/v02'
)
  .select('b0')
  .rename('sand_pct');

var siltPct = ee.Image.constant(100)
  .subtract(clayPct)
  .subtract(sandPct)
  .rename('silt_pct');

var lithology = ee.Image(
  'CSP/ERGo/1_0/US/lithology'
)
  .rename('lithology_class');

var mukeyImage = ee.ImageCollection(
  'projects/sat-io/open-datasets/gNATSGO/raster/mukey'
)
  .mosaic()
  .rename('GNATSGO_MUKEY')
  .unmask(-999);

var soilGeoStack = ee.Image.cat([
  nlcdImage,
  nlcdName,
  luScraped,
  textureClass,
  clayPct,
  sandPct,
  siltPct,
  lithology,
  mukeyImage
]);

print(
  'Soil, geology, and land-cover bands:',
  soilGeoStack.bandNames()
);


// ============================================================
// 8) AEZ, MLRA, AND LRR RASTERIZATION
// ============================================================

// ------------------------------------------------------------
// AEZ
// ------------------------------------------------------------

var AEZ = ee.FeatureCollection(
  'ESA/WorldCereal/AEZ/v100'
);

var US = ee.FeatureCollection(
  'USDOS/LSIB_SIMPLE/2017'
).filter(
  ee.Filter.eq(
    'country_na',
    'United States'
  )
);

var AEZ_US = AEZ.filterBounds(
  US.geometry()
);

var AEZ_ID = AEZ_US.reduceToImage({
  properties: ['aez_id'],
  reducer: ee.Reducer.first()
})
  .rename('AEZ_ID');

var AEZ_GROUPID = AEZ_US.reduceToImage({
  properties: ['aez_groupid'],
  reducer: ee.Reducer.first()
})
  .rename('AEZ_GROUPID');

var aezStack = ee.Image.cat([
  AEZ_ID,
  AEZ_GROUPID
]);


// ------------------------------------------------------------
// MLRA and LRR
// ------------------------------------------------------------

var mlraPolygons = ee.FeatureCollection(
  mlra
);

print(
  'MLRA polygon example:',
  mlraPolygons.first()
);

print(
  'MLRA polygon property names:',
  ee.Feature(
    mlraPolygons.first()
  ).propertyNames()
);

var mlraExample = ee.Feature(
  mlraPolygons.first()
);

var lrrField = firstExistingPropertyName(
  mlraExample,
  [
    'LRR_group',
    'LRR',
    'LRR_NAME',
    'LRR_CODE',
    'LRR_LTR',
    'LRR_LETTER',
    'LRRNUM',
    'LRR_NUM',
    'LRR_ID',
    'REGION',
    'Region',
    'REGION_ID',
    'REGION_NAME'
  ]
);

print(
  'Detected LRR property:',
  lrrField
);


// ------------------------------------------------------------
// Numeric MLRA ID
// ------------------------------------------------------------

var mlraNumeric = mlraPolygons.map(
  function(feature) {
    feature = ee.Feature(feature);

    var rawValue = ee.String(
      ee.Algorithms.If(
        feature.get('MLRA_ID'),
        feature.get('MLRA_ID'),
        ''
      )
    );

    var numericText = rawValue.replace(
      '[^0-9]',
      '',
      'g'
    );

    var numericValue = ee.Number(
      ee.Algorithms.If(
        numericText.length().gt(0),
        ee.Number.parse(numericText),
        -999
      )
    );

    return feature.set(
      'MLRA_ID_NUM',
      numericValue
    );
  }
);

var MLRA_ID = mlraNumeric.reduceToImage({
  properties: ['MLRA_ID_NUM'],
  reducer: ee.Reducer.first()
})
  .rename('MLRA_ID');


// ------------------------------------------------------------
// Numeric LRR encoding
// ------------------------------------------------------------

var lrrValues = ee.List(
  mlraPolygons
    .aggregate_array(lrrField)
    .distinct()
    .removeAll([
      null,
      ''
    ])
)
  .map(function(value) {
    return ee.String(value);
  })
  .sort();

print(
  'Sorted LRR values:',
  lrrValues
);

var lrrIndexSequence = ee.List(
  ee.Algorithms.If(
    lrrValues.size().gt(0),

    ee.List.sequence(
      0,
      lrrValues.size().subtract(1)
    ),

    ee.List([])
  )
);

var lrrEncodingTable = ee.FeatureCollection(
  lrrIndexSequence.map(
    function(index) {
      index = ee.Number(index).int();

      return ee.Feature(null, {
        extraction_date:
          OBS_DATE_STR,

        LRR_group_original:
          lrrValues.get(index),

        // Start at 1. Reserve -999 for missing.
        LRR_group_numeric:
          index.add(1)
      });
    }
  )
);

print(
  'LRR numeric encoding table:',
  lrrEncodingTable
);

var mlraWithLRRNumber = mlraPolygons.map(
  function(feature) {
    feature = ee.Feature(feature);

    var rawLRR = ee.String(
      ee.Algorithms.If(
        feature.get(lrrField),
        feature.get(lrrField),
        ''
      )
    );

    var zeroBasedIndex = lrrValues.indexOf(
      rawLRR
    );

    var numericLRR = ee.Number(
      ee.Algorithms.If(
        zeroBasedIndex.gte(0),
        zeroBasedIndex.add(1),
        -999
      )
    );

    return feature.set(
      'LRR_group_NUM',
      numericLRR
    );
  }
);

var LRR_group = mlraWithLRRNumber.reduceToImage({
  properties: ['LRR_group_NUM'],
  reducer: ee.Reducer.first()
})
  .rename('LRR_group');

var mlraLrrStack = ee.Image.cat([
  MLRA_ID,
  LRR_group
]);

print(
  'AEZ, MLRA, and LRR bands:',
  aezStack
    .addBands(mlraLrrStack)
    .bandNames()
);


// ============================================================
// 9) MODIS COLLECTIONS AND MASK FUNCTIONS
// ============================================================

function maskMOD13(image) {
  image = ee.Image(image);

  return image.updateMask(
    image
      .select('SummaryQA')
      .eq(0)
  );
}


function maskMOD09(image) {
  image = ee.Image(image);

  return image.updateMask(
    image
      .select('StateQA')
      .bitwiseAnd(3)
      .eq(0)
  );
}


var MOD13Q1 = ee.ImageCollection(
  'MODIS/061/MOD13Q1'
);

var MOD09A1 = ee.ImageCollection(
  'MODIS/061/MOD09A1'
);

var MOD16A2_RAW = ee.ImageCollection(
  'MODIS/061/MOD16A2'
);

var MOD16_ET = MOD16A2_RAW.map(
  prepareMOD16ET
);

print(
  'Total quality-controlled MOD16 ET images:',
  MOD16_ET.size()
);


// ============================================================
// 10) MODIS ONE-YEAR NDVI, EVI, NDWI, AND ET STATISTICS
// ============================================================

var NDVI_1Y_IC = MOD13Q1
  .filterDate(
    ONE_YEAR_START,
    OBS_DATE
  )
  .map(maskMOD13)
  .map(function(image) {
    return image
      .select('NDVI')
      .multiply(0.0001)
      .rename('NDVI')
      .copyProperties(
        image,
        ['system:time_start']
      );
  });

var EVI_1Y_IC = MOD13Q1
  .filterDate(
    ONE_YEAR_START,
    OBS_DATE
  )
  .map(maskMOD13)
  .map(function(image) {
    return image
      .select('EVI')
      .multiply(0.0001)
      .rename('EVI')
      .copyProperties(
        image,
        ['system:time_start']
      );
  });

var NDWI_1Y_IC = MOD09A1
  .filterDate(
    ONE_YEAR_START,
    OBS_DATE
  )
  .map(maskMOD09)
  .map(function(image) {
    var green = image
      .select('sur_refl_b04')
      .multiply(0.0001);

    var nir = image
      .select('sur_refl_b02')
      .multiply(0.0001);

    return green
      .subtract(nir)
      .divide(
        green.add(nir)
      )
      .rename('NDWI')
      .copyProperties(
        image,
        ['system:time_start']
      );
  });

var ET_1Y_IC = MOD16_ET.filterDate(
  ONE_YEAR_START,
  OBS_DATE
);

var ndviStats1y = statsFromCollection(
  NDVI_1Y_IC,
  'NDVI',
  'NDVI'
);

var eviStats1y = statsFromCollection(
  EVI_1Y_IC,
  'EVI',
  'EVI'
);

var ndwiStats1y = statsFromCollection(
  NDWI_1Y_IC,
  'NDWI',
  'NDWI'
);

var etSum1y = safeSum(
  ET_1Y_IC,
  'ET',
  'ET_sum'
);

var etStats1y = statsFromCollection(
  ET_1Y_IC,
  'ET',
  'ET'
)
  .select([
    'ET_p25',
    'ET_p75',
    'ET_IQR'
  ]);

var modisStatsStack = ee.Image.cat([
  ndviStats1y,
  eviStats1y,
  ndwiStats1y,
  etSum1y,
  etStats1y
]);

print(
  'MODIS one-year statistic bands:',
  modisStatsStack.bandNames()
);


// ============================================================
// 11) DAYMET AND ERA5-LAND ONE-YEAR CLIMATE STATISTICS
// ============================================================

var DAYMET = ee.ImageCollection(
  'NASA/ORNL/DAYMET_V4'
);

var ERA_D = ee.ImageCollection(
  'ECMWF/ERA5_LAND/DAILY_AGGR'
);

var daymet1y = DAYMET.filterDate(
  ONE_YEAR_START,
  OBS_DATE
);

var precipitation1y = daymet1y.map(
  function(image) {
    return image
      .select('prcp')
      .rename('prcp')
      .copyProperties(
        image,
        ['system:time_start']
      );
  }
);

var meanTemperature1y = daymet1y.map(
  function(image) {
    var meanTemperature = image
      .select('tmin')
      .add(
        image.select('tmax')
      )
      .divide(2)
      .rename('tmean');

    return meanTemperature.copyProperties(
      image,
      ['system:time_start']
    );
  }
);

var pptSum = safeSum(
  precipitation1y,
  'prcp',
  'ppt_sum'
);

var pptStats = statsFromCollection(
  precipitation1y,
  'prcp',
  'ppt'
)
  .select([
    'ppt_p25',
    'ppt_p75',
    'ppt_IQR'
  ]);

var matMean = safeMean(
  meanTemperature1y,
  'tmean',
  'MAT_mean'
);

var matStats = statsFromCollection(
  meanTemperature1y,
  'tmean',
  'MAT'
)
  .select([
    'MAT_p25',
    'MAT_p75',
    'MAT_IQR'
  ]);

var tminSpringCollection = DAYMET
  .filterDate(
    SPRING_START,
    SPRING_END
  )
  .select('tmin');

var tminSpringMin = ee.Image(
  ee.Algorithms.If(
    tminSpringCollection.size().gt(0),

    tminSpringCollection
      .min()
      .rename('Tmin_spring_min'),

    emptyBand('Tmin_spring_min')
  )
);

var srad1y = ERA_D
  .filterDate(
    ONE_YEAR_START,
    OBS_DATE
  )
  .select(
    'surface_solar_radiation_downwards_sum'
  );

var SRAD_1Y_MEAN = ee.Image(
  ee.Algorithms.If(
    srad1y.size().gt(0),

    srad1y
      .mean()
      .divide(1e6)
      .rename('SRAD_1y_mean_MJ'),

    emptyBand('SRAD_1y_mean_MJ')
  )
);

var climate1yStack = ee.Image.cat([
  pptSum,
  pptStats,
  matMean,
  matStats,
  tminSpringMin,
  SRAD_1Y_MEAN
]);

print(
  'One-year climate bands:',
  climate1yStack.bandNames()
);


// ============================================================
// 12) TEN-YEAR NDVI, NDWI, T2M, EVI, AND ET HARMONICS
// ============================================================

var NDVI_HARM_IC = MOD13Q1
  .map(maskMOD13)
  .map(function(image) {
    return image
      .select('NDVI')
      .multiply(0.0001)
      .rename('NDVI')
      .copyProperties(
        image,
        ['system:time_start']
      );
  });

var NDWI_HARM_IC = MOD09A1
  .map(maskMOD09)
  .map(function(image) {
    var green = image
      .select('sur_refl_b04')
      .multiply(0.0001);

    var nir = image
      .select('sur_refl_b02')
      .multiply(0.0001);

    return green
      .subtract(nir)
      .divide(
        green.add(nir)
      )
      .rename('NDWI')
      .copyProperties(
        image,
        ['system:time_start']
      );
  });

var T2M_HARM_IC = ERA_D.map(
  function(image) {
    return image
      .select('temperature_2m')
      .subtract(273.15)
      .rename('T2M')
      .copyProperties(
        image,
        ['system:time_start']
      );
  }
);

var ndviHarm = buildHarmCoeffs(
  NDVI_HARM_IC,
  'NDVI',
  TEN_YEAR_START,
  OBS_DATE,
  'NDVI'
);

var ndwiHarm = buildHarmCoeffs(
  NDWI_HARM_IC,
  'NDWI',
  TEN_YEAR_START,
  OBS_DATE,
  'NDWI'
);

var t2mHarm = buildHarmCoeffs(
  T2M_HARM_IC,
  'T2M',
  TEN_YEAR_START,
  OBS_DATE,
  'T2M'
);

var evi2Harm = buildEVI2HarmCoeffs(
  TEN_YEAR_START,
  OBS_DATE
);

var et2Harm = buildET2HarmCoeffs(
  MOD16_ET,
  TEN_YEAR_START,
  OBS_DATE
);

var harmonicStack = ee.Image.cat([
  ndviHarm,
  ndwiHarm,
  t2mHarm,
  evi2Harm,
  et2Harm
]);

print(
  'All harmonic bands:',
  harmonicStack.bandNames()
);

print(
  'ET harmonic bands:',
  et2Harm.bandNames()
);

print(
  'ET harmonic image count:',
  et2Harm.get(
    'ET_harmonic_n_images'
  )
);


// ============================================================
// 13) TEN-YEAR VPD AND PRECIPITATION FUNCTIONAL COVARIATES
// ============================================================

function addVPDDaymet(image) {
  image = ee.Image(image);

  var tmin = image.select('tmin');
  var tmax = image.select('tmax');

  var tmean = tmin
    .add(tmax)
    .divide(2)
    .rename('tmean');

  var saturationVaporPressure = tmean
    .multiply(17.27)
    .divide(
      tmean.add(237.3)
    )
    .exp()
    .multiply(0.6108)
    .rename('es_kPa');

  var actualVaporPressure = image
    .select('vp')
    .divide(1000)
    .rename('ea_kPa');

  var vpd = saturationVaporPressure
    .subtract(actualVaporPressure)
    .rename('VPD_kPa');

  var imageDate = ee.Date(
    image.get('system:time_start')
  );

  return image
    .addBands([
      tmean,
      vpd
    ])
    .set({
      year: imageDate.get('year'),
      month: imageDate.get('month')
    });
}


var daily10 = DAYMET
  .filterDate(
    CLIM10_START,
    CLIM10_END
  )
  .map(addVPDDaymet);

var vpdMean10 = daily10
  .select('VPD_kPa')
  .mean()
  .rename('VPD_mean_10y');

var vpdMax10 = daily10
  .select('VPD_kPa')
  .max()
  .rename('VPD_max_10y');

var vpdGrowingSeasonMean10 = daily10
  .map(function(image) {
    var growingSeasonMask = image
      .select('tmean')
      .gt(5);

    return image
      .select('VPD_kPa')
      .updateMask(
        growingSeasonMask
      )
      .rename('VPD_gs');
  })
  .mean()
  .rename('VPD_gs_mean_10y');

var months = ee.List.sequence(
  1,
  12
);


// ------------------------------------------------------------
// Monthly VPD climatology
// ------------------------------------------------------------

var monthlyVPDClim = ee.ImageCollection(
  months.map(function(month) {
    month = ee.Number(month).int();

    var monthlyCollection = daily10
      .filter(
        ee.Filter.eq(
          'month',
          month
        )
      )
      .select('VPD_kPa');

    var monthlyMean = monthlyCollection
      .mean()
      .rename('VPD_clim');

    var t = month
      .subtract(0.5)
      .divide(12);

    var twoPi = ee.Number(2)
      .multiply(Math.PI);

    var base = ee.Image.constant(0)
      .toFloat();

    var tBand = base
      .add(t)
      .rename('t');

    var angle = tBand.multiply(
      twoPi
    );

    var cos1 = angle
      .cos()
      .rename('cos1');

    var sin1 = angle
      .sin()
      .rename('sin1');

    var cos2 = angle
      .multiply(2)
      .cos()
      .rename('cos2');

    var sin2 = angle
      .multiply(2)
      .sin()
      .rename('sin2');

    var constant = base
      .add(1)
      .rename('constant');

    return constant
      .addBands([
        cos1,
        sin1,
        cos2,
        sin2,
        tBand,
        monthlyMean
      ])
      .set(
        'month',
        month
      );
  })
);

var vpdRegression = monthlyVPDClim
  .select([
    'constant',
    'cos1',
    'sin1',
    'cos2',
    'sin2',
    't',
    'VPD_clim'
  ])
  .reduce(
    ee.Reducer.linearRegression({
      numX: 6,
      numY: 1
    })
  );

var vpdCoefficients = vpdRegression
  .select('coefficients')
  .arrayProject([0])
  .arrayFlatten([[
    'VPD_beta0_10y',
    'VPD_a1_10y',
    'VPD_b1_10y',
    'VPD_a2_10y',
    'VPD_b2_10y',
    'VPD_trend_10y'
  ]]);

var vpdTrendAlias = vpdCoefficients
  .select('VPD_trend_10y')
  .rename('VPD_tcoef_10y');

var vpdAmplitude1 = vpdCoefficients
  .select('VPD_a1_10y')
  .pow(2)
  .add(
    vpdCoefficients
      .select('VPD_b1_10y')
      .pow(2)
  )
  .sqrt()
  .rename('VPD_amp1_10y');

var vpdPhase1 = vpdCoefficients
  .select('VPD_b1_10y')
  .multiply(-1)
  .atan2(
    vpdCoefficients.select(
      'VPD_a1_10y'
    )
  )
  .rename('VPD_phase1_10y');

var vpdAmplitude2 = vpdCoefficients
  .select('VPD_a2_10y')
  .pow(2)
  .add(
    vpdCoefficients
      .select('VPD_b2_10y')
      .pow(2)
  )
  .sqrt()
  .rename('VPD_amp2_10y');

var vpdPhase2 = vpdCoefficients
  .select('VPD_b2_10y')
  .multiply(-1)
  .atan2(
    vpdCoefficients.select('VPD_a2_10y')
  )
  .rename('VPD_phase2_10y');


// ------------------------------------------------------------
// Ten-year precipitation totals and variability
// ------------------------------------------------------------

var pptTotal10 = daily10
  .select('prcp')
  .sum()
  .rename('ppt_total_10y');

var pptAnnualMean10 = pptTotal10
  .divide(10)
  .rename('ppt_annual_mean_10y');

var years10 = ee.List.sequence(
  OBS_YEAR.subtract(10),
  OBS_YEAR.subtract(1)
);

var annualPPT = ee.ImageCollection(
  years10.map(function(year) {
    year = ee.Number(year).int();

    var yearStart = ee.Date.fromYMD(
      year,
      1,
      1
    );

    var yearEnd = yearStart.advance(
      1,
      'year'
    );

    return DAYMET
      .filterDate(
        yearStart,
        yearEnd
      )
      .select('prcp')
      .sum()
      .rename('ppt_annual');
  })
);

var pptMeanStd = annualPPT
  .select('ppt_annual')
  .reduce(
    ee.Reducer.mean().combine({
      reducer2: ee.Reducer.stdDev(),
      sharedInputs: true
    })
  );

var pptCV = pptMeanStd
  .select('ppt_annual_stdDev')
  .divide(
    pptMeanStd.select(
      'ppt_annual_mean'
    )
  )
  .rename('ppt_cv_10y');


// ------------------------------------------------------------
// Monthly precipitation climatology
// ------------------------------------------------------------

var monthlyPPTClim = ee.ImageCollection(
  months.map(function(month) {
    month = ee.Number(month).int();

    var monthlyCollection = daily10
      .filter(
        ee.Filter.eq(
          'month',
          month
        )
      )
      .select('prcp');

    var monthlyMean = monthlyCollection
      .mean()
      .rename('ppt_clim');

    var t = month
      .subtract(0.5)
      .divide(12);

    var twoPi = ee.Number(2)
      .multiply(Math.PI);

    var base = ee.Image.constant(0)
      .toFloat();

    var tBand = base
      .add(t)
      .rename('t');

    var angle = tBand.multiply(
      twoPi
    );

    var cos1 = angle
      .cos()
      .rename('cos1');

    var sin1 = angle
      .sin()
      .rename('sin1');

    var cos2 = angle
      .multiply(2)
      .cos()
      .rename('cos2');

    var sin2 = angle
      .multiply(2)
      .sin()
      .rename('sin2');

    var constant = base
      .add(1)
      .rename('constant');

    return constant
      .addBands([
        cos1,
        sin1,
        cos2,
        sin2,
        tBand,
        monthlyMean
      ])
      .set(
        'month',
        month
      );
  })
);

var pptRegression = monthlyPPTClim
  .select([
    'constant',
    'cos1',
    'sin1',
    'cos2',
    'sin2',
    't',
    'ppt_clim'
  ])
  .reduce(
    ee.Reducer.linearRegression({
      numX: 6,
      numY: 1
    })
  );

var pptCoefficients = pptRegression
  .select('coefficients')
  .arrayProject([0])
  .arrayFlatten([[
    'ppt_beta0_10y',
    'ppt_a1_10y',
    'ppt_b1_10y',
    'ppt_a2_10y',
    'ppt_b2_10y',
    'ppt_trend_10y'
  ]]);

var pptTrendAlias = pptCoefficients
  .select('ppt_trend_10y')
  .rename('ppt_tcoef_10y');

var pptAmplitude1 = pptCoefficients
  .select('ppt_a1_10y')
  .pow(2)
  .add(
    pptCoefficients
      .select('ppt_b1_10y')
      .pow(2)
  )
  .sqrt()
  .rename('ppt_amp1_10y');

var pptPhase1 = pptCoefficients
  .select('ppt_b1_10y')
  .multiply(-1)
  .atan2(
    pptCoefficients.select(
      'ppt_a1_10y'
    )
  )
  .rename('ppt_phase1_10y');

var pptAmplitude2 = pptCoefficients
  .select('ppt_a2_10y')
  .pow(2)
  .add(
    pptCoefficients
      .select('ppt_b2_10y')
      .pow(2)
  )
  .sqrt()
  .rename('ppt_amp2_10y');

var pptPhase2 = pptCoefficients
  .select('ppt_b2_10y')
  .multiply(-1)
  .atan2(
    pptCoefficients.select('ppt_a2_10y')
  )
  .rename('ppt_phase2_10y');

var climateFunctional10yStack = ee.Image.cat([
  vpdMean10,
  vpdGrowingSeasonMean10,
  vpdMax10,
  vpdCoefficients,
  vpdTrendAlias,
  vpdAmplitude1,
  vpdPhase1,
  vpdAmplitude2,
  vpdPhase2,
  pptTotal10,
  pptAnnualMean10,
  pptCV,
  pptCoefficients,
  pptTrendAlias,
  pptAmplitude1,
  pptPhase1,
  pptAmplitude2,
  pptPhase2
]);

print(
  'Ten-year climate functional bands:',
  climateFunctional10yStack.bandNames()
);


// ============================================================
// 14) TWELVE-MONTH ERA5 VPD MEAN
// ============================================================

var ERA5_DAILY = ee.ImageCollection(
  'ECMWF/ERA5/DAILY'
)
  .filterDate(
    ONE_YEAR_START,
    OBS_DATE
  )
  .select([
    'mean_2m_air_temperature',
    'dewpoint_2m_temperature'
  ]);

var VPD12_IC = ERA5_DAILY.map(
  function(image) {
    var temperature = image
      .select(
        'mean_2m_air_temperature'
      )
      .subtract(273.15);

    var dewpoint = image
      .select(
        'dewpoint_2m_temperature'
      )
      .subtract(273.15);

    var saturationVaporPressure =
      temperature.expression(
        '0.6108 * exp((17.27 * T) / (T + 237.3))',
        {
          T: temperature
        }
      );

    var actualVaporPressure =
      dewpoint.expression(
        '0.6108 * exp((17.27 * T) / (T + 237.3))',
        {
          T: dewpoint
        }
      );

    return saturationVaporPressure
      .subtract(actualVaporPressure)
      .rename('VPD_kPa')
      .copyProperties(
        image,
        ['system:time_start']
      );
  }
);

var VPD12 = ee.Image(
  ee.Algorithms.If(
    VPD12_IC.size().gt(0),

    VPD12_IC
      .mean()
      .rename('VPD_kPa'),

    emptyBand('VPD_kPa')
  )
);

print(
  'Twelve-month VPD band:',
  VPD12.bandNames()
);


// ============================================================
// 15) FIVE-YEAR FIRE FREQUENCY AND SMAP
// ============================================================

var burnCollection = ee.ImageCollection(
  'MODIS/061/MCD64A1'
)
  .filterDate(FIVE_YEAR_START, OBS_DATE)
  .select('BurnDate');

var fireYears = ee.List.sequence(
  ee.Number(
    FIVE_YEAR_START.get('year')
  ),
  ee.Number(
    OBS_DATE.get('year')
  )
);

var annualBurnWindow = fireYears.map(
  function(year) {
    year = ee.Number(year).int();

    var yearlyCollection = burnCollection
      .filter(
        ee.Filter.calendarRange(
          year,
          year,
          'year'
        )
      );

    var burnedYear = yearlyCollection
      .map(function(image) {
        return image.gt(0);
      })
      .max()
      .rename('burned_year');

    return burnedYear.set(
      'year',
      year
    );
  }
);

var burnWindowCollection = ee.ImageCollection(
  annualBurnWindow
);

var fireFrequency = burnWindowCollection
  .sum()
  .divide(
    ee.Image.constant(
      burnWindowCollection.size()
    )
  )
  .rename('fire_freq_win');

var smapCollection = ee.ImageCollection(
  'NASA_USDA/HSL/SMAP10KM_soil_moisture'
)
  .filterDate(
    FIVE_YEAR_START,
    OBS_DATE
  )
  .select('ssm');

print(
  'SMAP image count for five-year window:',
  smapCollection.size()
);

var smapWindow = ee.Image(
  ee.Algorithms.If(
    smapCollection.size().gt(0),

    smapCollection
      .mean()
      .rename('SMAP_ssm_mm_win'),

    emptyBand('SMAP_ssm_mm_win')
  )
);

var fireSmapStack = ee.Image.cat([
  fireFrequency,
  smapWindow
]);

print(
  'Fire and SMAP bands:',
  fireSmapStack.bandNames()
);


// ============================================================
// 16) LANDSAT GEOS3 SYSI AND SOIL FREQUENCY
// ============================================================

function applyScaleFactors(image) {
  var optical = image
    .select('SR_B.*')
    .multiply(0.0000275)
    .add(-0.2);

  var thermal = image
    .select('ST_B.*')
    .multiply(0.00341802)
    .add(149);

  return image
    .addBands(
      optical,
      null,
      true
    )
    .addBands(
      thermal,
      null,
      true
    );
}


function prepLandsatCollection(
  collectionId,
  startDate,
  endDate,
  region
) {
  var collection = ee.ImageCollection(
    collectionId
  )
    .filterDate(
      startDate,
      endDate
    )
    .filterBounds(region)
    .map(applyScaleFactors);

  var inputBands;
  var outputNames;

  if (
    collectionId.indexOf('LT04') >= 0 ||
    collectionId.indexOf('LT05') >= 0 ||
    collectionId.indexOf('LE07') >= 0
  ) {
    inputBands = [
      'SR_B1',
      'SR_B2',
      'SR_B3',
      'SR_B4',
      'SR_B5',
      'SR_B7',
      'QA_PIXEL'
    ];

    outputNames = [
      'blue',
      'green',
      'red',
      'nir',
      'swir1',
      'swir2',
      'pixel_qa'
    ];
  } else {
    inputBands = [
      'SR_B2',
      'SR_B3',
      'SR_B4',
      'SR_B5',
      'SR_B6',
      'SR_B7',
      'QA_PIXEL'
    ];

    outputNames = [
      'blue',
      'green',
      'red',
      'nir',
      'swir1',
      'swir2',
      'pixel_qa'
    ];
  }

  return collection.map(
    function(image) {
      return image.select(
        inputBands,
        outputNames
      );
    }
  );
}


function addQAMask(image) {
  var qa = image.select('pixel_qa');

  var notCloud = qa
    .bitwiseAnd(1 << 3)
    .eq(0);

  var notDilated = qa
    .bitwiseAnd(1 << 1)
    .eq(0);

  var notShadow = qa
    .bitwiseAnd(1 << 4)
    .eq(0);

  var notSnow = qa
    .bitwiseAnd(1 << 5)
    .eq(0);

  var clearMask = notCloud
    .and(notDilated)
    .and(notShadow)
    .and(notSnow);

  return image
    .updateMask(clearMask)
    .addBands(
      clearMask.rename('QAmask')
    );
}


function addIndices(image) {
  var ndvi = image.expression(
    '(nir - red) / (nir + red)',
    {
      nir: image.select('nir'),
      red: image.select('red')
    }
  )
    .rename('NDVI');

  var nbr2 = image.expression(
    '(swir1 - swir2) / (swir1 + swir2)',
    {
      swir1: image.select('swir1'),
      swir2: image.select('swir2')
    }
  )
    .rename('NBR2');

  var spectralTrend = image.expression(
    '(blue < green) && ' +
    '(green < red) && ' +
    '(red < nir) && ' +
    '(nir < swir1)',
    {
      blue: image.select('blue'),
      green: image.select('green'),
      red: image.select('red'),
      nir: image.select('nir'),
      swir1: image.select('swir1')
    }
  )
    .rename('ST');

  var drySoil = image.expression(
    '(swir2 > blue) && (red > 0.05)',
    {
      blue: image.select('blue'),
      red: image.select('red'),
      swir2: image.select('swir2')
    }
  )
    .rename('DS');

  return image.addBands([
    ndvi,
    nbr2,
    spectralTrend,
    drySoil
  ]);
}


function addIsSoil(image) {
  var isSoil = image.expression(
    'QAmask > 0 && ' +
    'NDVI >= -0.10 && ' +
    'NDVI <= 0.25 && ' +
    'NBR2 > -0.10 && ' +
    'NBR2 <= 0.10 && ' +
    'ST > 0 && ' +
    'DS > 0',
    {
      QAmask: image.select('QAmask'),
      NDVI: image.select('NDVI'),
      NBR2: image.select('NBR2'),
      ST: image.select('ST'),
      DS: image.select('DS')
    }
  )
    .rename('isSoil');

  return image.addBands(isSoil);
}


function ensureBands(
  image,
  names
) {
  image = ee.Image(image);
  names = ee.List(names);

  return ee.Image(
    ee.Algorithms.If(
      image.bandNames().size().eq(0),

      ee.Image.constant(
        ee.List.repeat(
          0,
          names.size()
        )
      )
        .rename(names)
        .updateMask(
          ee.Image.constant(0)
        ),

      image
    )
  );
}


var waterMask = ee.Image(
  'UMD/hansen/global_forest_change_2016_v1_4'
)
  .select('datamask')
  .neq(1)
  .eq(0);


function makeGEOS3CompositeRaster(
  startDate,
  endDate,
  region
) {
  var landsat4 = prepLandsatCollection(
    'LANDSAT/LT04/C02/T1_L2',
    startDate,
    endDate,
    region
  );

  var landsat5 = prepLandsatCollection(
    'LANDSAT/LT05/C02/T1_L2',
    startDate,
    endDate,
    region
  );

  var landsat7 = prepLandsatCollection(
    'LANDSAT/LE07/C02/T1_L2',
    startDate,
    endDate,
    region
  );

  var landsat8 = prepLandsatCollection(
    'LANDSAT/LC08/C02/T1_L2',
    startDate,
    endDate,
    region
  );

  var allLandsat = landsat4
    .merge(landsat5)
    .merge(landsat7)
    .merge(landsat8)
    .map(addQAMask)
    .map(addIndices)
    .map(addIsSoil);

  var spectralBands = [
    'blue',
    'green',
    'red',
    'nir',
    'swir1',
    'swir2'
  ];

  var baselineCollection = allLandsat.map(
    function(image) {
      return image
        .select('QAmask')
        .gt(0)
        .rename('Baseline');
    }
  );

  var soilFlagCollection = allLandsat.map(
    function(image) {
      return image.select('isSoil');
    }
  );

  var sysiRaw = allLandsat
    .map(function(image) {
      return image
        .updateMask(
          image.select('isSoil')
        )
        .select(spectralBands);
    })
    .median();

  var sysi = ensureBands(
    sysiRaw,
    spectralBands
  )
    .rename([
      'blue_median',
      'green_median',
      'red_median',
      'nir_median',
      'swir1_median',
      'swir2_median'
    ])
    .updateMask(waterMask);

  var baselineSum = ensureBands(
    baselineCollection
      .sum()
      .rename('Baseline'),
    ['Baseline']
  );

  var soilSum = ensureBands(
    soilFlagCollection
      .sum()
      .rename('SoilFrequency'),
    ['SoilFrequency']
  );

  var soilFrequency = soilSum
    .divide(baselineSum)
    .rename('SF_median')
    .updateMask(
      baselineSum.neq(0)
    )
    .updateMask(waterMask);

  return sysi.addBands(
    soilFrequency
  );
}


var landsatSYSISF = makeGEOS3CompositeRaster(
  ONE_YEAR_START,
  OBS_DATE,
  CONUS
);

print(
  'Landsat SYSI and SF bands:',
  landsatSYSISF.bandNames()
);


// ============================================================
// 17) BUILD FINAL MASTER STACK
// ============================================================

var masterStackRaw = ee.Image.cat([
  topoStack,
  soilGeoStack,
  aezStack,
  mlraLrrStack,
  modisStatsStack,
  climate1yStack,
  harmonicStack,
  climateFunctional10yStack,
  VPD12,
  fireSmapStack,
  landsatSYSISF
]);

var masterStack = masterStackRaw
  .clip(CONUS)
  .toFloat()
  .set({
    extraction_date:
      OBS_DATE_STR,

    extraction_date_tag:
      OBS_DATE_TAG,

    extraction_millis:
      OBS_DATE.millis(),

    extraction_year:
      OBS_YEAR,

    nlcd_year_used:
      NLCD_YEAR,

    one_year_start:
      ONE_YEAR_START.millis(),

    five_year_start:
      FIVE_YEAR_START.millis(),

    ten_year_start:
      TEN_YEAR_START.millis(),

    clim10_start:
      CLIM10_START.millis(),

    clim10_end:
      CLIM10_END.millis(),

    export_bucket:
      GCS_BUCKET,

    export_folder:
      GCS_FOLDER,

    NLCD_name_encoding:
      'Numeric NLCD class code',

    LU_scraped_encoding:
      '1=C, 2=F, 3=R, 4=X',

    LRR_group_encoding:
      'Numeric index; see exported LRR lookup table'
  });

print(
  'MASTER STACK BAND COUNT:',
  masterStack.bandNames().size()
);

print(
  'MASTER STACK BANDS:',
  masterStack.bandNames()
);


// ============================================================
// 18) VERIFY REQUIRED NEW BANDS
// ============================================================

var requiredNewBands = ee.List([
  'LRR_group',
  'NLCD_name',
  'LU_scraped',
  'ET_beta0',
  'ET_a1',
  'ET_b1',
  'ET_a2',
  'ET_b2',
  'ET_trend'
]);

var missingNewBands = requiredNewBands.removeAll(
  masterStack.bandNames()
);

print(
  'Required newly added bands:',
  requiredNewBands
);

print(
  'Missing newly added bands; should be empty:',
  missingNewBands
);


// ============================================================
// 19) VERIFY REQUESTED RASTER MODEL FEATURES
// ============================================================

var requestedModelBands = ee.List([
  'AEZ_GROUPID',
  'AEZ_ID',
  'ASPECT',
  'EL_MERIT',
  'ET_sum',
  'EVI_a1',
  'EVI_a2',
  'EVI_b1',
  'EVI_b2',
  'EVI_beta0',
  'EVI_mean',
  'EVI_trend',
  'LULC',
  'LU_scraped',
  'MAT_mean',
  'MLRA_ID',
  'NDVI_mean',
  'NDWI_mean',
  'SF_median',
  'SL',
  'SOIL_TEXTURE',
  'Tmin_spring_min',
  'VPD_a1_10y',
  'VPD_b1_10y',
  'VPD_beta0_10y',
  'VPD_gs_mean_10y',
  'VPD_kPa',
  'VPD_max_10y',
  'VPD_mean_10y',
  'VPD_tcoef_10y',
  'clay_pct',
  'lithology_class',
  'ppt_a1_10y',
  'ppt_annual_mean_10y',
  'ppt_b1_10y',
  'ppt_beta0_10y',
  'ppt_cv_10y',
  'ppt_sum',
  'ppt_tcoef_10y',
  'ppt_total_10y',
  'sand_pct',
  'silt_pct',
  'AI',
  'HAND',
  'TWI',
  'NDVI_a1',
  'NDVI_b1',
  'NDVI_beta0',
  'NDVI_trend',
  'NDWI_a1',
  'NDWI_b1',
  'NDWI_beta0',
  'NDWI_trend',
  'SRAD_1y_mean_MJ',
  'T2M_a1',
  'T2M_b1',
  'T2M_beta0',
  'T2M_trend',
  'LRR_group',
  'NLCD_name',
  'ET_a1',
  'ET_b1',
  'ET_a2',
  'ET_b2',
  'ET_beta0',
  'ET_trend'
]);

var missingRequestedModelBands =
  requestedModelBands.removeAll(
    masterStack.bandNames()
  );

print(
  'Missing requested raster model bands:',
  missingRequestedModelBands
);


// ============================================================
// 20) MAP PREVIEWS
// ============================================================

Map.addLayer(
  masterStack.select('TWI'),
  {},
  'TWI',
  false
);

Map.addLayer(
  masterStack.select('NDVI_mean'),
  {},
  'NDVI mean',
  false
);

Map.addLayer(
  masterStack.select('ppt_sum'),
  {},
  'Precipitation sum',
  false
);

Map.addLayer(
  masterStack.select('VPD_mean_10y'),
  {},
  'VPD mean 10 years',
  false
);

Map.addLayer(
  masterStack.select('ET_sum'),
  {},
  'ET sum',
  false
);

Map.addLayer(
  masterStack.select('ET_beta0'),
  {},
  'ET beta0',
  false
);

Map.addLayer(
  masterStack.select('ET_a1'),
  {},
  'ET a1',
  false
);

Map.addLayer(
  masterStack.select('ET_a2'),
  {},
  'ET a2',
  false
);

Map.addLayer(
  masterStack.select('LRR_group'),
  {},
  'LRR group numeric',
  false
);

Map.addLayer(
  masterStack.select('MLRA_ID'),
  {},
  'MLRA ID',
  false
);

Map.addLayer(
  masterStack.select('NLCD_name'),
  {
    min: 11,
    max: 95
  },
  'NLCD numeric class',
  false
);

Map.addLayer(
  masterStack.select('LU_scraped'),
  {
    min: 1,
    max: 4
  },
  'LU scraped numeric class',
  false
);

Map.addLayer(
  masterStack.select('SF_median'),
  {},
  'Soil frequency',
  false
);


// ============================================================
// 21) SAMPLE EVERY COVARIATE ONCE PER UNIQUE POINT
// ============================================================

// A masked value in any band causes sampleRegions to omit that point.
// Unmasking the completed stack guarantees one output row per input row;
// unavailable covariates receive NODATA_VALUE instead.
var masterStackForPoints = masterStack.unmask(
  NODATA_VALUE,
  false
);

var pointCovariates = masterStackForPoints.sampleRegions({
  collection: inputPoints,
  scale: SCALE_EXPORT,
  geometries: true,
  tileScale: 4
}).map(function(feature) {
  return ee.Feature(feature).set({
    extraction_date: OBS_DATE_STR,
    extraction_year: OBS_YEAR,
    extraction_scale_m: SCALE_EXPORT,
    covariate_nodata_value: NODATA_VALUE
  });
});

print('Pointwise output row count:', pointCovariates.size());
print('Expected unique input point count:', inputPoints.size());
print('First pointwise output row:', pointCovariates.first());
print(
  'Pointwise output property count:',
  ee.Feature(pointCovariates.first()).propertyNames().size()
);


// ============================================================
// 22) EXPORT POINTWISE COVARIATES TO GOOGLE DRIVE
// ============================================================

Export.table.toDrive({
  collection: pointCovariates,
  description: POINT_EXPORT_DESCRIPTION,
  folder: POINT_EXPORT_FOLDER,
  fileNamePrefix: POINT_EXPORT_BASENAME,
  fileFormat: 'CSV'
});

// ============================================================
// 23) FINAL EXPORT SUMMARY
// ============================================================

print('Point export description:', POINT_EXPORT_DESCRIPTION);
print(
  'Point export destination:',
  'Google Drive/' + POINT_EXPORT_FOLDER + '/' +
  POINT_EXPORT_BASENAME + '.csv'
);
print('No raster export is created by this script.');
print('Open the Tasks tab and run the single CSV export.');
