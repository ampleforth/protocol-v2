import {
  eContractid,
  eEthereumNetwork,
  iMultiPoolsAssets,
  IReserveParams,
  tEthereumAddress,
} from './types';
import { AaveProtocolDataProvider } from '../types/AaveProtocolDataProvider';
import { chunk, DRE, getDb, waitForTx } from './misc-utils';
import {
  getAaveProtocolDataProvider,
  getAToken,
  getATokensAndRatesHelper,
  getLendingPool,
  getLendingPoolAddressesProvider,
  getStableAndVariableTokensHelper,
} from './contracts-getters';
import { rawInsertContractAddressInDb } from './contracts-helpers';
import { BigNumber, BigNumberish, Signer } from 'ethers';
import {
  deployAAmplToken,
  deployAmplStableDebtToken,
  deployAmplVariableDebtToken,
  deployDefaultReserveInterestRateStrategy,
  deployDelegationAwareAToken,
  deployGenericAToken,
  deployStableDebtToken,
  deployVariableDebtToken,
} from './contracts-deployments';
import { ZERO_ADDRESS } from './constants';
import { isZeroAddress } from 'ethereumjs-util';

export const chooseATokenDeployment = (id: eContractid) => {
  switch (id) {
    case eContractid.AToken:
      return deployGenericAToken;
    case eContractid.DelegationAwareAToken:
      return deployDelegationAwareAToken;
    // case eContractid.AAmplToken:
    //   return deployAAmplToken;
    default:
      throw Error(`Missing aToken deployment script for: ${id}`);
  }
};

// deploy all
const FILTER_DEPLOY: string[]=[];

// deploy subset
// const FILTER_DEPLOY = ["WBTC", "WETH", "DAI", "AMPL", "UNI", "AAVE", "USDC"];

function deployTokenSubset(reservesParams: iMultiPoolsAssets<IReserveParams>):string[] {
  return Object.keys(reservesParams).filter(a => FILTER_DEPLOY.length == 0 || FILTER_DEPLOY.includes(a))
}

function deployReserveSubset(reservesParams: iMultiPoolsAssets<IReserveParams>):[string, IReserveParams][] {
  return Object.entries(reservesParams).filter(a => FILTER_DEPLOY.length == 0 || FILTER_DEPLOY.includes(a[0]));
}

export const initReservesByHelper = async (
  reservesParams: iMultiPoolsAssets<IReserveParams>,
  tokenAddresses: { [symbol: string]: tEthereumAddress },
  admin: tEthereumAddress,
  treasuryAddress: tEthereumAddress,
  incentivesController: tEthereumAddress,
  verify: boolean
): Promise<BigNumber> => {
  let gasUsage = BigNumber.from('0');
  const stableAndVariableDeployer = await getStableAndVariableTokensHelper();
  const atokenAndRatesDeployer = await getATokensAndRatesHelper();

  const addressProvider = await getLendingPoolAddressesProvider();
  const poolAddress = await addressProvider.getLendingPool();

  // Set aTokenAndRatesDeployer as temporal admin
  await waitForTx(await addressProvider.setPoolAdmin(atokenAndRatesDeployer.address));

  // CHUNK CONFIGURATION
  const tokensChunks = 2;
  const initChunks = 4;

  // Deploy tokens and rates that uses common aToken in chunks
  const reservesChunks = chunk(
    deployReserveSubset(reservesParams).filter(
      ([_, { aTokenImpl }]) => aTokenImpl === eContractid.AToken
    ) as [string, IReserveParams][],
    tokensChunks
  );

  // Initialize variables for future reserves initialization
  let deployedStableTokens: string[] = [];
  let deployedVariableTokens: string[] = [];
  let deployedATokens: string[] = [];
  let deployedRates: string[] = [];
  let reserveTokens: string[] = [];
  let reserveInitDecimals: string[] = [];
  let reserveSymbols: string[] = [];

  console.log(
    `- Token deployments in ${reservesChunks.length * 2} txs instead of ${
      deployReserveSubset(reservesParams).length * 4
    } txs`
  );
  for (let reservesChunk of reservesChunks) {
    // Prepare data
    const tokens: string[] = [];
    const symbols: string[] = [];
    const strategyRates: [
      BigNumberish,
      BigNumberish,
      BigNumberish,
      BigNumberish,
      BigNumberish,
      BigNumberish
    ][] = [];
    const reservesDecimals: string[] = [];

    for (let [assetSymbol, { reserveDecimals }] of reservesChunk) {
      const assetAddressIndex = Object.keys(tokenAddresses).findIndex(
        (value) => value === assetSymbol
      );
      const [, tokenAddress] = (Object.entries(tokenAddresses) as [string, string][])[
        assetAddressIndex
      ];

      const reserveParamIndex = deployTokenSubset(reservesParams).findIndex(
        (value) => value === assetSymbol
      );
      const [
        ,
        {
          optimalUtilizationRate,
          baseVariableBorrowRate,
          variableRateSlope1,
          variableRateSlope2,
          stableRateSlope1,
          stableRateSlope2,
        },
      ] = deployReserveSubset(reservesParams)[reserveParamIndex];
      // Add to lists
      tokens.push(tokenAddress);
      symbols.push(assetSymbol);
      strategyRates.push([
        optimalUtilizationRate,
        baseVariableBorrowRate,
        variableRateSlope1,
        variableRateSlope2,
        stableRateSlope1,
        stableRateSlope2,
      ]);
      reservesDecimals.push(reserveDecimals);
    }

    // Deploy stable and variable deployers and save implementations
    const tx1 = await waitForTx(
      await stableAndVariableDeployer.initDeployment(tokens, symbols, incentivesController)
    );
    tx1.events?.forEach((event, index) => {
      rawInsertContractAddressInDb(`stableDebt${symbols[index]}`, event?.args?.stableToken);
      rawInsertContractAddressInDb(`variableDebt${symbols[index]}`, event?.args?.variableToken);
    });

    // Deploy atokens and rate strategies and save implementations
    const tx2 = await waitForTx(
      await atokenAndRatesDeployer.initDeployment(
        tokens,
        symbols,
        strategyRates,
        treasuryAddress,
        incentivesController
      )
    );
    tx2.events?.forEach((event, index) => {
      rawInsertContractAddressInDb(`a${symbols[index]}`, event?.args?.aToken);
      rawInsertContractAddressInDb(`strategy${symbols[index]}`, event?.args?.strategy);
    });

    console.log(`  - Deployed aToken, DebtTokens and Strategy for: ${symbols.join(', ')} `);
    console.log('    * gasUsed: debtTokens batch', tx1.gasUsed.toString());
    console.log('    * gasUsed: aTokens and Strategy batch', tx2.gasUsed.toString());
    gasUsage = gasUsage.add(tx1.gasUsed).add(tx2.gasUsed);

    const stableTokens: string[] = tx1.events?.map((e) => e.args?.stableToken) || [];
    const variableTokens: string[] = tx1.events?.map((e) => e.args?.variableToken) || [];
    const aTokens: string[] = tx2.events?.map((e) => e.args?.aToken) || [];
    const strategies: string[] = tx2.events?.map((e) => e.args?.strategy) || [];

    deployedStableTokens = [...deployedStableTokens, ...stableTokens];
    deployedVariableTokens = [...deployedVariableTokens, ...variableTokens];
    deployedATokens = [...deployedATokens, ...aTokens];
    deployedRates = [...deployedRates, ...strategies];
    reserveInitDecimals = [...reserveInitDecimals, ...reservesDecimals];
    reserveTokens = [...reserveTokens, ...tokens];
    reserveSymbols = [...reserveSymbols, ...symbols];
  }

  // Deploy delegated aware reserves tokens
  const delegatedAwareReserves = deployReserveSubset(reservesParams).filter(
    ([_, { aTokenImpl }]) => aTokenImpl === eContractid.DelegationAwareAToken
  ) as [string, IReserveParams][];

  for (let [symbol, params] of delegatedAwareReserves) {
    console.log(`  - Deploy ${symbol} delegation aware aToken, debts tokens, and strategy`);
    const {
      optimalUtilizationRate,
      baseVariableBorrowRate,
      variableRateSlope1,
      variableRateSlope2,
      stableRateSlope1,
      stableRateSlope2,
    } = params;
    const deployCustomAToken = chooseATokenDeployment(params.aTokenImpl);
    const aToken = await deployCustomAToken(
      [
        poolAddress,
        tokenAddresses[symbol],
        treasuryAddress,
        `Aave interest bearing ${symbol}`,
        `a${symbol}`,
        ZERO_ADDRESS,
      ],
      verify
    );
    const stableDebt = await deployStableDebtToken(
      [
        poolAddress,
        tokenAddresses[symbol],
        `Aave stable debt bearing ${symbol}`,
        `stableDebt${symbol}`,
        ZERO_ADDRESS,
      ],
      verify
    );
    const variableDebt = await deployVariableDebtToken(
      [
        poolAddress,
        tokenAddresses[symbol],
        `Aave variable debt bearing ${symbol}`,
        `variableDebt${symbol}`,
        ZERO_ADDRESS,
      ],
      verify
    );
    const rates = await deployDefaultReserveInterestRateStrategy(
      [
        addressProvider.address,
        optimalUtilizationRate,
        baseVariableBorrowRate,
        variableRateSlope1,
        variableRateSlope2,
        stableRateSlope1,
        stableRateSlope2,
      ],
      verify
    );

    deployedStableTokens.push(stableDebt.address);
    deployedVariableTokens.push(variableDebt.address);
    deployedATokens.push(aToken.address);
    deployedRates.push(rates.address);
    reserveInitDecimals.push(params.reserveDecimals);
    reserveTokens.push(tokenAddresses[symbol]);
    reserveSymbols.push(symbol);
  }

  // Deploy elastic reserves tokens
  const ElasticSupplyReserves = deployReserveSubset(reservesParams).filter(
    ([_, { aTokenImpl }]) => aTokenImpl === eContractid.AAmplToken
  ) as [string, IReserveParams][];

  let aAMPLToken, amplStableDebt, amplVariableDebt;
  for (let [symbol, params] of ElasticSupplyReserves) {
    console.log(`  - Deploy ${symbol} elastic supply aToken, debts tokens, and strategy`);
    const {
      optimalUtilizationRate,
      baseVariableBorrowRate,
      variableRateSlope1,
      variableRateSlope2,
      stableRateSlope1,
      stableRateSlope2,
    } = params;

    amplStableDebt = await deployAmplStableDebtToken(
      [
        poolAddress,
        tokenAddresses[symbol],
        `Aave stable debt bearing ${symbol}`,
        `stableDebt${symbol}`,
        ZERO_ADDRESS,
      ],
      verify
    );
    amplVariableDebt = await deployAmplVariableDebtToken(
      [
        poolAddress,
        tokenAddresses[symbol],
        `Aave variable debt bearing ${symbol}`,
        `variableDebt${symbol}`,
        ZERO_ADDRESS,
      ],
      verify
    );
    aAMPLToken = await deployAAmplToken(
      [
        poolAddress,
        tokenAddresses[symbol],
        treasuryAddress,
        `Aave interest bearing ${symbol}`,
        `a${symbol}`,
        ZERO_ADDRESS,
      ],
      verify
    );

    const rates = await deployDefaultReserveInterestRateStrategy(
      [
        addressProvider.address,  // Change for LendingPoolAddressesProvider(addressesProvider)
        optimalUtilizationRate,
        baseVariableBorrowRate,
        variableRateSlope1,
        variableRateSlope2,
        stableRateSlope1,
        stableRateSlope2,
      ],
      verify
    );

    deployedStableTokens.push(amplStableDebt.address);
    deployedVariableTokens.push(amplVariableDebt.address);
    deployedATokens.push(aAMPLToken.address);
    deployedRates.push(rates.address);
    reserveInitDecimals.push(params.reserveDecimals);
    reserveTokens.push(tokenAddresses[symbol]);
    reserveSymbols.push(symbol);
  }

  // Deploy init reserves per chunks
  const chunkedStableTokens = chunk(deployedStableTokens, initChunks);
  const chunkedVariableTokens = chunk(deployedVariableTokens, initChunks);
  const chunkedAtokens = chunk(deployedATokens, initChunks);
  const chunkedRates = chunk(deployedRates, initChunks);
  const chunkedDecimals = chunk(reserveInitDecimals, initChunks);
  const chunkedSymbols = chunk(reserveSymbols, initChunks);

  console.log(`- Reserves initialization in ${chunkedStableTokens.length} txs`);
  for (let chunkIndex = 0; chunkIndex < chunkedDecimals.length; chunkIndex++) {
    const tx3 = await waitForTx(
      await atokenAndRatesDeployer.initReserve(
        chunkedStableTokens[chunkIndex],
        chunkedVariableTokens[chunkIndex],
        chunkedAtokens[chunkIndex],
        chunkedRates[chunkIndex],
        chunkedDecimals[chunkIndex]
      )
    );

    console.log(`  - Reserve ready for: ${chunkedSymbols[chunkIndex].join(', ')}`);
    console.log('    * gasUsed', tx3.gasUsed.toString());
    gasUsage = gasUsage.add(tx3.gasUsed);
  }

  let pool = await getLendingPool(poolAddress);
  let reserve = await pool.getReserveData(tokenAddresses['AMPL']);

  // Set AMPL debt tokens
  await aAMPLToken.initializeDebtTokens();

  // Set deployer back as admin
  await waitForTx(await addressProvider.setPoolAdmin(admin));
  return gasUsage;
};

export const getPairsTokenAggregator = (
  allAssetsAddresses: {
    [tokenSymbol: string]: tEthereumAddress;
  },
  aggregatorsAddresses: { [tokenSymbol: string]: tEthereumAddress }
): [string[], string[]] => {
  const { ETH, USD, WETH, ...assetsAddressesWithoutEth } = allAssetsAddresses;

  const pairs = Object.entries(assetsAddressesWithoutEth).map(([tokenSymbol, tokenAddress]) => {
    if (tokenSymbol !== 'WETH' && tokenSymbol !== 'ETH') {
      const aggregatorAddressIndex = Object.keys(aggregatorsAddresses).findIndex(
        (value) => value === tokenSymbol
      );
      const [, aggregatorAddress] = (Object.entries(aggregatorsAddresses) as [
        string,
        tEthereumAddress
      ][])[aggregatorAddressIndex];
      return [tokenAddress, aggregatorAddress];
    }
  }) as [string, string][];

  const mappedPairs = pairs.map(([asset]) => asset);
  const mappedAggregators = pairs.map(([, source]) => source);

  return [mappedPairs, mappedAggregators];
};

export const configureReservesByHelper = async (
  reservesParams: iMultiPoolsAssets<IReserveParams>,
  tokenAddresses: { [symbol: string]: tEthereumAddress },
  helpers: AaveProtocolDataProvider,
  admin: tEthereumAddress
) => {
  const addressProvider = await getLendingPoolAddressesProvider();
  const atokenAndRatesDeployer = await getATokensAndRatesHelper();
  const tokens: string[] = [];
  const symbols: string[] = [];
  const baseLTVA: string[] = [];
  const liquidationThresholds: string[] = [];
  const liquidationBonuses: string[] = [];
  const reserveFactors: string[] = [];
  const stableRatesEnabled: boolean[] = [];

  for (const [
    assetSymbol,
    {
      baseLTVAsCollateral,
      liquidationBonus,
      liquidationThreshold,
      reserveFactor,
      stableBorrowRateEnabled,
    },
  ] of deployReserveSubset(reservesParams) as [string, IReserveParams][]) {
    if (baseLTVAsCollateral === '-1') continue;

    const assetAddressIndex = Object.keys(tokenAddresses).findIndex(
      (value) => value === assetSymbol
    );
    const [, tokenAddress] = (Object.entries(tokenAddresses) as [string, string][])[
      assetAddressIndex
    ];
    const { usageAsCollateralEnabled: alreadyEnabled } = await helpers.getReserveConfigurationData(
      tokenAddress
    );

    if (alreadyEnabled) {
      console.log(`- Reserve ${assetSymbol} is already enabled as collateral, skipping`);
      continue;
    }
    // Push data
    tokens.push(tokenAddress);
    symbols.push(assetSymbol);
    baseLTVA.push(baseLTVAsCollateral);
    liquidationThresholds.push(liquidationThreshold);
    liquidationBonuses.push(liquidationBonus);
    reserveFactors.push(reserveFactor);
    stableRatesEnabled.push(stableBorrowRateEnabled);
  }
  if (tokens.length) {
    // Set aTokenAndRatesDeployer as temporal admin
    await waitForTx(await addressProvider.setPoolAdmin(atokenAndRatesDeployer.address));

    // Deploy init per chunks
    const enableChunks = 20;
    const chunkedTokens = chunk(tokens, enableChunks);
    const chunkedSymbols = chunk(symbols, enableChunks);
    const chunkedBase = chunk(baseLTVA, enableChunks);
    const chunkedliquidationThresholds = chunk(liquidationThresholds, enableChunks);
    const chunkedliquidationBonuses = chunk(liquidationBonuses, enableChunks);
    const chunkedReserveFactors = chunk(reserveFactors, enableChunks);
    const chunkedStableRatesEnabled = chunk(stableRatesEnabled, enableChunks);

    console.log(`- Configure reserves in ${chunkedTokens.length} txs`);
    for (let chunkIndex = 0; chunkIndex < chunkedTokens.length; chunkIndex++) {
      await waitForTx(
        await atokenAndRatesDeployer.configureReserves(
          chunkedTokens[chunkIndex],
          chunkedBase[chunkIndex],
          chunkedliquidationThresholds[chunkIndex],
          chunkedliquidationBonuses[chunkIndex],
          chunkedReserveFactors[chunkIndex],
          chunkedStableRatesEnabled[chunkIndex],
          { gasLimit: 12000000 }
        )
      );
      console.log(`  - Init for: ${chunkedSymbols[chunkIndex].join(', ')}`);
    }
    // Set deployer back as admin
    await waitForTx(await addressProvider.setPoolAdmin(admin));
  }
};

const getAddressById = async (
  id: string,
  network: eEthereumNetwork
): Promise<tEthereumAddress | undefined> =>
  (await getDb().get(`${id}.${network}`).value())?.address || undefined;

export const initTokenReservesByHelper = async (
  reservesParams: iMultiPoolsAssets<IReserveParams>,
  tokenAddresses: { [symbol: string]: tEthereumAddress },
  admin: tEthereumAddress,
  addressesProviderAddress: tEthereumAddress,
  ratesHelperAddress: tEthereumAddress,
  dataProviderAddress: tEthereumAddress,
  signer: Signer,
  treasuryAddress: tEthereumAddress,
  verify: boolean
) => {
  let gasUsage = BigNumber.from('0');
  const atokenAndRatesDeployer = await (await getATokensAndRatesHelper(ratesHelperAddress)).connect(
    signer
  );

  const addressProvider = await (
    await getLendingPoolAddressesProvider(addressesProviderAddress)
  ).connect(signer);
  const protocolDataProvider = await (
    await getAaveProtocolDataProvider(dataProviderAddress)
  ).connect(signer);
  const poolAddress = await addressProvider.getLendingPool();

  // Set aTokenAndRatesDeployer as temporal admin
  await waitForTx(await addressProvider.setPoolAdmin(atokenAndRatesDeployer.address));

  // CHUNK CONFIGURATION
  const initChunks = 4;

  // Initialize variables for future reserves initialization
  let deployedStableTokens: string[] = [];
  let deployedVariableTokens: string[] = [];
  let deployedATokens: string[] = [];
  let deployedRates: string[] = [];
  let reserveInitDecimals: string[] = [];
  let reserveSymbols: string[] = [];
  const network =
    process.env.MAINNET_FORK === 'true'
      ? eEthereumNetwork.main
      : (DRE.network.name as eEthereumNetwork);
  // Grab config from DB
  for (const [symbol, address] of Object.entries(tokenAddresses)) {
    const { aTokenAddress } = await protocolDataProvider.getReserveTokensAddresses(address);
    const reserveParamIndex = deployTokenSubset(reservesParams).findIndex((value) => value === symbol);
    const [, { reserveDecimals: decimals }] = (deployReserveSubset(reservesParams) as [
      string,
      IReserveParams
    ][])[reserveParamIndex];

    if (!isZeroAddress(aTokenAddress)) {
      console.log(`- Skipping ${symbol} due already initialized`);
      continue;
    }
    let stableTokenImpl = await getAddressById(`stableDebt${symbol}`, network);
    let variableTokenImpl = await getAddressById(`variableDebt${symbol}`, network);
    let aTokenImplementation = await getAddressById(`a${symbol}`, network);
    let strategyImpl = await getAddressById(`strategy${symbol}`, network);

    if (!stableTokenImpl) {
      const stableDebt = await deployStableDebtToken(
        [
          poolAddress,
          tokenAddresses[symbol],
          `Aave stable debt bearing ${symbol}`,
          `stableDebt${symbol}`,
          ZERO_ADDRESS,
        ],
        verify
      );
      stableTokenImpl = stableDebt.address;
    }
    if (!variableTokenImpl) {
      const variableDebt = await deployVariableDebtToken(
        [
          poolAddress,
          tokenAddresses[symbol],
          `Aave variable debt bearing ${symbol}`,
          `variableDebt${symbol}`,
          ZERO_ADDRESS,
        ],
        verify
      );
      variableTokenImpl = variableDebt.address;
    }
    if (!aTokenImplementation) {
      const [, { aTokenImpl }] = (deployReserveSubset(reservesParams) as [string, IReserveParams][])[
        reserveParamIndex
      ];
      const deployCustomAToken = chooseATokenDeployment(aTokenImpl);
      const aToken = await deployCustomAToken(
        [
          poolAddress,
          tokenAddresses[symbol],
          treasuryAddress,
          `Aave interest bearing ${symbol}`,
          `a${symbol}`,
          ZERO_ADDRESS,
        ],
        verify
      );
      aTokenImplementation = aToken.address;
    }
    if (!strategyImpl) {
      const [
        ,
        {
          optimalUtilizationRate,
          baseVariableBorrowRate,
          variableRateSlope1,
          variableRateSlope2,
          stableRateSlope1,
          stableRateSlope2,
        },
      ] = deployReserveSubset(reservesParams)[reserveParamIndex];
      const rates = await deployDefaultReserveInterestRateStrategy(
        [
          addressProvider.address,
          optimalUtilizationRate,
          baseVariableBorrowRate,
          variableRateSlope1,
          variableRateSlope2,
          stableRateSlope1,
          stableRateSlope2,
        ],
        verify
      );
      strategyImpl = rates.address;
    }
    const symbols = [`a${symbol}`, `variableDebt${symbol}`, `stableDebt${symbol}`];
    const tokens = [aTokenImplementation, variableTokenImpl, stableTokenImpl];
    for (let index = 0; index < symbols.length; index++) {
      if (!(await isErc20SymbolCorrect(tokens[index], symbols[index]))) {
        console.error(`${symbol} and implementation does not match: ${tokens[index]}`);
        throw Error('Symbol does not match implementation.');
      }
    }
    console.log(`- Added ${symbol} to the initialize batch`);
    deployedStableTokens.push(stableTokenImpl);
    deployedVariableTokens.push(variableTokenImpl);
    deployedATokens.push(aTokenImplementation);
    deployedRates.push(strategyImpl);
    reserveInitDecimals.push(decimals.toString());
    reserveSymbols.push(symbol);
  }

  // Deploy init reserves per chunks
  const chunkedStableTokens = chunk(deployedStableTokens, initChunks);
  const chunkedVariableTokens = chunk(deployedVariableTokens, initChunks);
  const chunkedAtokens = chunk(deployedATokens, initChunks);
  const chunkedRates = chunk(deployedRates, initChunks);
  const chunkedDecimals = chunk(reserveInitDecimals, initChunks);
  const chunkedSymbols = chunk(reserveSymbols, initChunks);

  console.log(`- Reserves initialization in ${chunkedStableTokens.length} txs`);
  for (let chunkIndex = 0; chunkIndex < chunkedDecimals.length; chunkIndex++) {
    const tx3 = await waitForTx(
      await atokenAndRatesDeployer.initReserve(
        chunkedStableTokens[chunkIndex],
        chunkedVariableTokens[chunkIndex],
        chunkedAtokens[chunkIndex],
        chunkedRates[chunkIndex],
        chunkedDecimals[chunkIndex]
      )
    );

    console.log(`  - Reserve ready for: ${chunkedSymbols[chunkIndex].join(', ')}`);
    console.log('    * gasUsed', tx3.gasUsed.toString());
    gasUsage = gasUsage.add(tx3.gasUsed);
  }

  // Set deployer back as admin
  await waitForTx(await addressProvider.setPoolAdmin(admin));
  return gasUsage;
};

const isErc20SymbolCorrect = async (token: tEthereumAddress, symbol: string) => {
  const erc20 = await getAToken(token); // using aToken for ERC20 interface
  const erc20Symbol = await erc20.symbol();
  return symbol === erc20Symbol;
};
