/**
 * ZEROVA EV + BESS ROI 核心試算引擎 (純演算法，無 DOM 操作)
 */
const ROIEngine = {
    // 1. 台電費率與基礎常數
    TARIFFS: {
        hv_ev: { name: '高壓專用電價', discount: 0.95 },
        lv_ev: { name: '低壓專用電價', discount: 1.00 }
    },
    RATES: {
        basicSummer: 47.20,      // 夏月經常契約基本費 (元/kW/月)
        basicNonSummer: 34.60,   // 非夏月經常契約基本費 (元/kW/月)
        avgPowerCost: 3.8,       // 預設台電平均購電成本 (元/kWh)
        evCapexRate: 6000,       // 充電樁完工建置單價 (元/kW)
        bessCapexRate: 14000,    // 儲能設備建置單價 (元/kWh)
        emsCost: 300000,         // EMS 軟硬體費用 (元)
        auxPowerKw: 20           // 輔電系統預留容量 (kW)
    },

    /**
     * 計算第一區塊：單純充電站 (Baseline)
     */
    calcStandalone(inputs) {
        const { tariffType, gunCount, gunPower, dailyKwh, chargingPrice } = inputs;
        
        // 全站充電總功率
        const totalPowerKw = gunCount * gunPower;
        
        // 建議契約容量 (無儲能：全功率輸出 + 輔電預留 20kW)
        const auxPowerKw = this.RATES.auxPowerKw;
        const recContractKw = totalPowerKw + auxPowerKw;
        
        // 充電樁建置 CAPEX (總功率 * 6,000 元/kW)
        const evCapex = totalPowerKw * this.RATES.evCapexRate;

        // 台電折算費率 (按高壓專用電價 95% 折扣)
        const discount = this.TARIFFS[tariffType]?.discount || 0.95;
        const basicSummer = this.RATES.basicSummer * discount;
        const basicNonSummer = this.RATES.basicNonSummer * discount;

        // 充電賣電年毛利
        const annualKwh = dailyKwh * 365;
        const annualChargingProfit = annualKwh * (chargingPrice - this.RATES.avgPowerCost);

        // 無儲能下的年度台電基本電費支出 (4個月夏月 + 8個月非夏月)
        const annualCapacityCost = recContractKw * (4 * basicSummer + 8 * basicNonSummer);
        const annualNetBenefit = annualChargingProfit - annualCapacityCost;

        // 回收年限
        const paybackYears = annualNetBenefit > 0 ? (evCapex / annualNetBenefit).toFixed(1) : "無法回本";

        return {
            totalPowerKw,
            auxPowerKw,
            recContractKw,
            evCapex,
            annualChargingProfit,
            annualCapacityCost,
            annualNetBenefit,
            paybackYears,
            basicSummer,
            basicNonSummer
        };
    },

    /**
     * 計算第二區塊：充儲一體化 (BESS + DLM)
     */
    calcIntegrated(inputs, standaloneResult) {
        const {
            enableBess, targetContractKw, bessKw, bessKwh,
            chkAvoidCapex, chkCapacitySavings, chkTouArbitrage, chkPenaltyAvoided
        } = inputs;

        // 未勾選儲能時，傳回與第一區塊相同數據
        if (!enableBess) {
            const cashFlowA = [-standaloneResult.evCapex];
            for (let i = 1; i <= 10; i++) {
                cashFlowA.push(-standaloneResult.evCapex + (standaloneResult.annualNetBenefit * i));
            }
            return {
                enableBess: false,
                totalCapex: standaloneResult.evCapex,
                annualNetBenefit: standaloneResult.annualNetBenefit,
                paybackYears: standaloneResult.paybackYears,
                breakdown: { chargingProfit: standaloneResult.annualChargingProfit, capacitySavings: 0, touArbitrage: 0, penaltyAvoided: 0 },
                cashFlowA,
                cashFlowB: cashFlowA
            };
        }

        const { totalPowerKw, recContractKw, evCapex, annualChargingProfit, basicSummer, basicNonSummer } = standaloneResult;

        // 高壓擴容工程避險費用 (約 150 萬元)
        const avoidedCapexVal = chkAvoidCapex ? 1500000 : 0;
        const bessCost = bessKwh * this.RATES.bessCapexRate;
        const totalCapex = Math.max(0, (evCapex + bessCost + this.RATES.emsCost) - avoidedCapexVal);

        // 1. 降低基本電費節省
        const capacitySavedKw = Math.max(0, recContractKw - targetContractKw);
        const valCapacitySavings = chkCapacitySavings ? capacitySavedKw * (4 * basicSummer + 8 * basicNonSummer) : 0;

        // 2. 尖離峰時間電價套利 (DoD 90%, RTE 88%)
        const dailyBessDischarge = bessKwh * 0.9 * 0.88;
        const valTouArbitrage = chkTouArbitrage ? ((dailyBessDischarge * 7.0 * 120) + (dailyBessDischarge * 3.8 * 245)) : 0;

        // 3. 超約罰款規避價值 (預設防護 15% 突發尖峰超約)
        const valPenaltyAvoided = chkPenaltyAvoided ? (totalPowerKw * 0.15) * (basicSummer * 2 * 4 + basicNonSummer * 2 * 8) : 0;

        // 充儲方案年度總綜合效益
        const annualNetBenefit = annualChargingProfit + valCapacitySavings + valTouArbitrage + valPenaltyAvoided;
        const paybackYears = annualNetBenefit > 0 ? (totalCapex / annualNetBenefit).toFixed(1) : "無法回本";

        // 生成 10 年期現金流對比陣列
        const cashFlowA = [-evCapex];
        const cashFlowB = [-totalCapex];
        for (let i = 1; i <= 10; i++) {
            cashFlowA.push(-evCapex + (standaloneResult.annualNetBenefit * i));
            cashFlowB.push(-totalCapex + (annualNetBenefit * i));
        }

        return {
            enableBess: true,
            totalCapex,
            annualNetBenefit,
            paybackYears,
            breakdown: {
                chargingProfit: annualChargingProfit,
                capacitySavings: valCapacitySavings,
                touArbitrage: valTouArbitrage,
                penaltyAvoided: valPenaltyAvoided
            },
            cashFlowA,
            cashFlowB
        };
    },

    /**
     * 主進入點
     */
    run(inputs) {
        const standalone = this.calcStandalone(inputs);
        const integrated = this.calcIntegrated(inputs, standalone);
        return { standalone, integrated };
    }
};
